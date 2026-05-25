import prisma from '../db/index.js';
import { generateResponse } from '../utils/gemini.js';
import logger from '../utils/logger.js';

/**
 * Determina el stage del pipeline basado en los datos reales de UserData y el agente.
 * Reglas determinísticas, NO depende de la IA.
 */
function determinarPipelineStage(userData: Record<string, any>, ultimaRespuesta: string, historial: string): string {
	// Si la respuesta del asistente contiene instrucciones de pago concretas o confirmación de compra
	if (/(?:transferencia|consignaci[oó]n|PSE|tarjeta|cuenta de ahorros|cuenta corriente|Nequi|DaviPlata|Banco)\s*(?:\d|\s){4,}/i.test(ultimaRespuesta)) {
		return 'VENTA_CERRADA';
	}

	const tieneNombre = !!userData?.nombre;
	const tieneCedula = !!userData?.cedula;
	const tieneDireccion = !!userData?.direccion;
	const tieneTelefono = !!userData?.telefono;
	const tieneProducto = !!userData?.productoSolicitado;
	const tienePresupuesto = !!userData?.presupuesto;
	const tieneCiudad = !!userData?.ciudad;

	// VENTA_CERRADA: el cliente aceptó comprar, le dimos datos de pago
	if (tieneNombre && tieneProducto && /comprar|pagar|compra|confirmo|ok|si|d[ée]le|listo|completa|adelante/i.test(historial.slice(-200))) {
		return 'VENTA_CERRADA';
	}

	// PRESUPUESTO_LISTO: producto + presupuesto
	if (tieneProducto && tienePresupuesto) {
		return 'PRESUPUESTO_LISTO';
	}

	// CONTACTO_COMPLETO: nombre + cédula + al menos un dato de contacto
	if (tieneNombre && tieneCedula && (tieneDireccion || tieneTelefono)) {
		return 'CONTACTO_COMPLETO';
	}

	// PRODUCTO_INTERES: sabemos qué producto busca
	if (tieneProducto) {
		return 'PRODUCTO_INTERES';
	}

	// CIUDAD_VALIDADA: tenemos ciudad
	if (tieneCiudad) {
		return 'CIUDAD_VALIDADA';
	}

	return 'INITIAL';
}

/**
 * Agente extractor de datos (IA backend).
 * No habla con el cliente. Lee el historial de la conversación y extrae
 * datos concretos para guardarlos en UserData.
 * El pipeline stage se determina por reglas, no por la IA.
 */
export async function extractAndSaveData(
	leadId: string,
	_contactId: string,
	_body: string,
	history: Array<{ direction: string; body: string; sentAt: Date }>,
	currentUserData: Record<string, any>,
	_agentType: string,
	responseText: string
): Promise<void> {
	try {
		const historial = history
			.slice(-12)
			.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
			.join('\n');

		const userDataStr = Object.entries(currentUserData)
			.filter(([_, v]) => v != null && v !== '' && v !== '{}')
			.map(([k, v]) => `${k}: ${v}`)
			.join('\n');

		// ── 1. Extraer datos del historial con IA ──────────────────────────
		const prompt = `Eres un extractor de datos de clientes. Lees la conversación y extraes información del cliente.

DATOS ACTUALES:
${userDataStr || '(ninguno)'}

HISTORIAL:
${historial}

--- INSTRUCCIONES ---
Extrae ÚNICAMENTE datos NUEVOS que el cliente haya mencionado explícitamente y que NO estén ya en la base de datos.

Campos a extraer (solo si están EXPLÍCITAMENTE en la conversación):
- nombre: nombre completo del cliente
- cedula: número de cédula (solo dígitos)
- direccion: dirección que mencionó
- telefono: teléfono que mencionó
- presupuesto: presupuesto o cantidad que dijo estar dispuesto a pagar
- productoSolicitado: producto que busca (nevera, televisor, lavadora, repuesto, etc.)
- ciudad: ciudad donde está
- departamento: departamento donde está

Responde SOLO con JSON válido, sin markdown ni explicaciones:
{"datos":{}}

Ejemplo: {"datos":{"nombre":"Carlos","ciudad":"Medellín"}}
Si no hay datos nuevos: {"datos":{}}`;

		const raw = await generateResponse(prompt);

		// Extraer el PRIMER objeto JSON completo del texto
		function extraerPrimerJson(texto: string): string {
			const inicio = texto.indexOf('{');
			if (inicio < 0) return texto;
			let profundidad = 0;
			for (let i = inicio; i < texto.length; i++) {
				if (texto[i] === '{') profundidad++;
				else if (texto[i] === '}') profundidad--;
				if (profundidad === 0) return texto.slice(inicio, i + 1);
			}
			return texto.slice(inicio);
		}

		const jsonStr = extraerPrimerJson(raw);
		const parsed = JSON.parse(jsonStr);
		const datos: Record<string, string> = parsed.datos || {};

		// ── 2. Guardar solo campos nuevos en UserData ──────────────────────
		const updateData: Record<string, any> = {};
		for (const [key, value] of Object.entries(datos)) {
			if (value && String(value) !== String(currentUserData[key] ?? '')) {
				updateData[key] = String(value);
			}
		}

		if (Object.keys(updateData).length > 0) {
			await prisma.userData.upsert({
				where: { leadId },
				update: updateData,
				create: { leadId, ...updateData },
			});
			logger.info({ leadId, updateData }, 'DataExtractor: UserData actualizado');
		}

		// ── 3. Leer UserData actualizada de la DB para pipeline ────────────
		const freshUserData = await prisma.userData.findUnique({ where: { leadId } });
		const merged = { ...currentUserData, ...updateData, ...(freshUserData || {}) };

		// ── 4. Determinar pipeline stage por reglas (determinístico) ───────
		const stage = determinarPipelineStage(merged, responseText, historial);

		// Leer lead actual para no retroceder
		const lead = await prisma.lead.findUnique({ where: { id: leadId } });
		if (!lead) return;

		const stages = ['INITIAL', 'CIUDAD_VALIDADA', 'PRODUCTO_INTERES', 'CONTACTO_COMPLETO', 'PRESUPUESTO_LISTO', 'VENTA_CERRADA', 'RECHAZADO'];
		const idxActual = stages.indexOf(lead.stage);
		const idxNuevo = stages.indexOf(stage);

		// Solo avanzar, nunca retroceder
		if (idxNuevo > idxActual) {
			await prisma.lead.update({
				where: { id: leadId },
				data: { stage },
			});
			logger.info({ leadId, stageAnterior: lead.stage, stageNuevo: stage }, 'DataExtractor: Pipeline avanzado');
		}
	} catch (error: any) {
		logger.error({ err: error, leadId, msg: error?.message || String(error) }, 'DataExtractor: Error (no crítico)');
	}
}
