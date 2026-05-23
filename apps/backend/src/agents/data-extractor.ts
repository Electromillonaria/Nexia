import prisma from '../db/index.js';
import { generateResponse } from '../utils/gemini.js';
import logger from '../utils/logger.js';

interface ExtractedData {
	nombre?: string;
	cedula?: string;
	direccion?: string;
	telefono?: string;
	presupuesto?: string;
	productoSolicitado?: string;
	ciudad?: string;
	departamento?: string;
}

interface PipelineAction {
	stage?: string;
	type?: string;
}

/**
 * Agente extractor de datos (IA backend).
 * No habla con el cliente. Lee el historial de la conversación y extrae
 * datos concretos del cliente para guardarlos en UserData, y decide
 * el siguiente paso del pipeline de ventas.
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
			.filter(([_, v]) => v != null && v !== '{}')
			.map(([k, v]) => `${k}: ${v}`)
			.join('\n');

		const prompt = `Eres un extractor de datos de clientes para JLC Electronics. Lees la conversación y extraes información del cliente.

DATOS ACTUALES EN BASE DE DATOS:
${userDataStr || '(ninguno)'}

ÚLTIMA RESPUESTA DEL ASISTENTE:
${responseText}

HISTORIAL DE LA CONVERSACIÓN:
${historial}

--- INSTRUCCIONES ---
Extrae ÚNICAMENTE datos NUEVOS que el cliente haya mencionado explícitamente y que NO estén ya en la base de datos.

Campos a extraer (solo si están EXPLÍCITAMENTE en la conversación):
- nombre: nombre completo del cliente
- cedula: número de cédula (solo dígitos)
- direccion: dirección que mencionó
- telefono: teléfono que mencionó
- presupuesto: presupuesto o cantidad que dijo estar dispuesto a pagar
- productoSolicitado: producto que busca (nevera, televisor, lavadora, repuesto específico, etc.)
- ciudad: ciudad donde está
- departamento: departamento donde está

Además, determina el AVANCE DEL PIPELINE según la conversación:
- "INITIAL": primer contacto, saludo
- "CIUDAD_VALIDADA": ya tenemos ciudad y departamento
- "PRODUCTO_INTERES": ya sabemos qué producto busca
- "CONTACTO_COMPLETO": tenemos nombre + cédula + dirección + teléfono
- "PRESUPUESTO_LISTO": tenemos producto y presupuesto
- "VENTA_CERRADA": aceptó comprar, dimos instrucciones de pago
- "RECHAZADO": dijo que no le interesa o no quiere comprar

Responde SOLO con JSON válido en este formato exacto, sin explicaciones ni markdown:
{
  "datos": { "nombre": null, "cedula": null, "direccion": null, "telefono": null, "presupuesto": null, "productoSolicitado": null, "ciudad": null, "departamento": null },
  "pipeline": { "stage": null, "type": "CONSULTA" }
}

Solo incluye campos con valor. Si no hay datos nuevos, devuelve objetos vacíos.`;

		const raw = await generateResponse(prompt);
		const jsonStr = raw.replace(/```json\s*|\s*```/g, '').trim();
		const parsed = JSON.parse(jsonStr);

		const datos: ExtractedData = parsed.datos || {};
		const pipeline: PipelineAction = parsed.pipeline || {};

		// Construir update de UserData solo con campos nuevos
		const updateData: Record<string, any> = {};
		for (const [key, value] of Object.entries(datos)) {
			if (value && value !== currentUserData[key]) {
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

		// Avanzar pipeline si corresponde
		if (pipeline.stage && pipeline.stage !== currentUserData.stage) {
			const validStages = ['INITIAL', 'CIUDAD_VALIDADA', 'PRODUCTO_INTERES', 'CONTACTO_COMPLETO', 'PRESUPUESTO_LISTO', 'VENTA_CERRADA', 'RECHAZADO'];
			if (validStages.includes(pipeline.stage)) {
				await prisma.lead.update({
					where: { id: leadId },
					data: {
						stage: pipeline.stage,
						...(pipeline.type ? { type: pipeline.type } : {}),
					},
				});
				logger.info({ leadId, stage: pipeline.stage, type: pipeline.type }, 'DataExtractor: Pipeline actualizado');
			}
		}
	} catch (error) {
		logger.error({ error, leadId }, 'DataExtractor: Error extrayendo datos');
	}
}
