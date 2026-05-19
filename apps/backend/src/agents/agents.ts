import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';

export interface AgentResponse {
	response: string;
	nextStage?: string;
	shouldTransfer?: boolean;
	metadata?: Record<string, any>;
}

export interface IAgent {
	name: string;
	handle(message: string, context: any): Promise<AgentResponse>;
}

// ─── Helper: formatear historial ─────────────────────────────────────────────

function formatHistory(history: Array<{ direction: string; body: string }>): string {
	if (!history || history.length === 0) return '(primer mensaje del cliente)';
	return history
		.slice(-6)
		.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
		.join('\n');
}

// ─── Helper: limpiar respuesta de Gemma ──────────────────────────────────────
//
// Gemma a veces incluye razonamiento ("Goal:", "Tone:", asteriscos, etc.)
// antes de la respuesta final. Esta función intenta extraer solo la respuesta
// dirigida al cliente.

function cleanResponse(raw: string): string {
	if (!raw) return '';
	let text = raw.trim();

	// 1. Eliminar bloques de razonamiento explícito
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
	text = text.replace(/```[\s\S]*?```/g, ''); // bloques de código
	text = text.replace(/\*\*[^*]+\*\*/g, (m) => m.replace(/\*/g, '')); // bold markdown

	// 2. Si Gemma marca explícitamente la respuesta final, cortar ahí
	const finalMarkers = [
		/(?:^|\n)\s*(?:respuesta final|respuesta al cliente|respuesta|mensaje al cliente|asistente|assistant|output|final)\s*:\s*/i,
	];
	for (const re of finalMarkers) {
		const m = text.match(re);
		if (m && typeof m.index === 'number') {
			text = text.slice(m.index + m[0].length);
			break;
		}
	}

	// 3. Eliminar líneas que son claramente razonamiento interno
	const skipPatterns = [
		/^(user message|customer input|customer message|mensaje del cliente)\s*:/i,
		/^(goal|objetivo|tono|tone|constraints|restricciones|reglas|rules)\s*:/i,
		/^(role|rol|catalog|catálogo|workflow|context|contexto|history|historial)\s*:/i,
		/^(self[- ]correction|constraint check|check|análisis|analysis|reasoning|razonamiento)\s*:/i,
		/^(paso \d+|step \d+)\s*[:\-]/i,
		/^(yes|no|sí|si)\s*$/i,
		/^[*\-_=]{2,}\s*$/, // líneas de solo símbolos
		/^\s*[*\-]\s*(friendly|professional|emojis|spanish|max \d+ words)/i,
	];

	const lines = text.split('\n');
	const kept: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!t) {
			kept.push('');
			continue;
		}
		if (skipPatterns.some((p) => p.test(t))) continue;
		kept.push(line);
	}

	let cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

	// 4. Si quedó vacío o demasiado corto, devolver el original sin etiquetas
	if (cleaned.length < 20) {
		cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	}

	return cleaned;
}

// ─── Constructor de prompt estilo Gemma ──────────────────────────────────────
//
// Gemma sigue mejor instrucciones cuando:
//  - El rol está al inicio en UNA frase clara.
//  - La información de la empresa va como "DATOS" (no como pseudocódigo).
//  - El flujo se describe en lenguaje natural numerado.
//  - Las reglas de formato van al FINAL, justo antes del input del cliente.
//  - El input del cliente va separado con marcadores claros.

function buildGemmaPrompt(opts: {
	rol: string;
	datos: string;
	flujo: string;
	reglas: string;
	historial: string;
	mensajeCliente: string;
}): { system: string; user: string } {
	const system = `${opts.rol}

DATOS DE LA EMPRESA:
${opts.datos}

CÓMO ATENDER AL CLIENTE:
${opts.flujo}

REGLAS DE FORMATO (obligatorias):
${opts.reglas}

IMPORTANTE: Responde ÚNICAMENTE con el texto que el cliente debe leer. No escribas "Respuesta:", no muestres pasos, no uses asteriscos, no expliques tu razonamiento. Solo el mensaje al cliente, en español natural.`;

	const user = `Historial reciente:
${opts.historial}

Mensaje actual del cliente:
"${opts.mensajeCliente}"

Escribe tu respuesta al cliente:`;

	return { system, user };
}

// ─── AGENTE VENTAS ───────────────────────────────────────────────────────────

export class VentasAgent implements IAgent {
	name = 'Ventas';

	async handle(message: string, context: any): Promise<AgentResponse> {
		let productList = '';
		try {
			const products = await wooCommerceService.searchProducts(message, 4);
			productList = wooCommerceService.formatProductList(products);
		} catch {
			productList = 'Catálogo no disponible en este momento.';
		}

		const { system, user } = buildGemmaPrompt({
			rol: 'Eres un asesor comercial de Electrodomésticos JLC. Tu trabajo es atender clientes que quieren comprar electrodomésticos, cotizar, o pedir información de productos.',

			datos: `Empresa: Electrodomésticos JLC (sitio web https://jlc-electronics.com/)
Modalidades de compra: al por mayor (distribuidores) o al detal (crédito o contado).
Cobertura especial: Putumayo tiene asesor dedicado.
Asesora que cierra ventas: Cristina, WhatsApp +57 318 740 8190.

Catálogo relacionado con la consulta:
${productList || 'Sin coincidencias en catálogo.'}`,

			flujo: `1. Saluda brevemente y preséntate como asesor de JLC.
2. Pregunta qué producto necesita y desde qué ciudad escribe.
3. Pregunta si la compra es al por mayor o al detal.
   - Si es al por mayor: dile que lo conectarás con el área de distribuidores y pide su nombre, ciudad y NIT.
   - Si es al detal: pregunta si desea pagar de contado o a crédito.
4. Si es al detal CONTADO: indica el artículo, precio, disponibilidad en su zona, y menciona que los medios de pago están en la página web. Cierra ofreciendo el contacto de Cristina (+57 318 740 8190) para finalizar la venta.
5. Si es al detal CRÉDITO: explica que para crédito se necesita un formulario con datos personales, de residencia, laborales y financieros, y que Cristina (+57 318 740 8190) lo gestiona. Pide primero nombre, cédula e ingresos mensuales para iniciar.
6. Si la ciudad es Putumayo: indica que hay un asesor dedicado para esa zona y pide los datos básicos para conectarlo.
7. Si la ciudad no tiene cobertura: avisa amablemente que aún no llegan a esa zona.`,

			reglas: `- Máximo 80 palabras por respuesta.
- Tono cordial, claro, profesional, en español de Colombia.
- Una sola pregunta o llamada a la acción al final.
- No repitas todo el flujo: avanza un paso a la vez según el historial.
- No uses asteriscos, viñetas con * ni encabezados.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			nextStage: 'PROPOSAL',
			metadata: { agentType: 'ventas' },
		};
	}
}

// ─── AGENTE CARTERA ──────────────────────────────────────────────────────────

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente del área de cartera de Electrodomésticos JLC. Tu trabajo es redirigir al cliente a los canales correctos porque desde este chat no se accede a información personal de cartera.',

			datos: `Canales oficiales de cartera y facturación:
- WhatsApp cartera: +57 314 422 9949 y +57 315 721 2367
- Soporte de pago de crédito: enviar al WhatsApp +57 314 422 9949 o +57 315 721 2367
- Línea telefónica: +57 320 788 1108 (horario 12:30 p.m. a 2:30 p.m.)
- Correo para peticiones con soportes: callcenter5@electromillonaria.co`,

			flujo: `1. Reconoce con empatía la consulta del cliente (pago, deuda, recordatorio, etc.).
2. Explica que desde esta línea no se puede acceder a su información personal.
3. Comparte los canales oficiales según lo que pida: WhatsApp de cartera, línea telefónica o correo.
4. Si menciona dificultades para pagar, sugiere comunicarse con cartera para evaluar una reestructuración.
5. Cierra preguntando si necesita algo más.`,

			reglas: `- Máximo 70 palabras.
- Tono amable pero firme.
- Incluye los números o correo solo si son relevantes a lo que pide.
- Sin asteriscos ni viñetas con símbolos.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'cartera' },
		};
	}
}

// ─── AGENTE SERVICIO TÉCNICO ─────────────────────────────────────────────────

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de servicio técnico de Electrodomésticos JLC. Tu trabajo es ayudar al cliente con reparaciones, mantenimiento o fallas de sus electrodomésticos, y conectarlo con el equipo técnico cuando corresponda.',

			datos: `Contactos de servicio técnico JLC:
- Servicio Técnico JLC: +57 320 788 1151
- Servicio Técnico JLC (Diego): +57 320 788 1110
- Sitio web: https://jlc-electronics.com/servicio-tecnico/
Horario de atención: lunes a sábado, 8:00 a.m. a 5:00 p.m.`,

			flujo: `1. Saluda brevemente y pregunta qué electrodoméstico presenta la falla (marca, modelo y, si lo sabe, año).
2. Pide que describa los síntomas (qué falla exactamente, cuándo ocurre).
3. Indica los canales de servicio técnico (números arriba) y el horario de atención.
4. Si ya dio todos los datos, recomiéndale escribir directamente al número de servicio técnico para agendar.`,

			reglas: `- Máximo 80 palabras.
- Tono profesional, cercano.
- Una pregunta a la vez si faltan datos.
- Sin asteriscos ni listas con símbolos.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'servicio_tecnico' },
		};
	}
}

// ─── AGENTE REPUESTOS ────────────────────────────────────────────────────────

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		let productInfo = '';
		try {
			const products = await wooCommerceService.searchProducts(message + ' repuesto', 3);
			if (products.length > 0) {
				productInfo = wooCommerceService.formatProductList(products);
			}
		} catch {
			// continuar sin catálogo
		}

		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de repuestos de Electrodomésticos JLC. Ayudas al cliente a encontrar el repuesto que necesita, dar precio y disponibilidad.',

			datos: `Tiempos: si un repuesto no está en stock, el tiempo de pedido es de 3 a 5 días hábiles.
Sitio web: https://jlc-electronics.com/

Repuestos relacionados con la consulta:
${productInfo || 'Sin coincidencias en catálogo.'}`,

			flujo: `1. Pregunta marca, modelo y año del electrodoméstico, y qué repuesto necesita (si no lo dio aún).
2. Si encuentras coincidencias en el catálogo, indica precio y disponibilidad.
3. Si no hay stock, avisa el tiempo de pedido (3 a 5 días).
4. Cierra preguntando si desea reservarlo.`,

			reglas: `- Máximo 70 palabras.
- Tono claro y útil.
- Sin asteriscos ni símbolos de lista.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'repuestos' },
		};
	}
}

// ─── AGENTE VACANTES ─────────────────────────────────────────────────────────

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de recursos humanos de Electrodomésticos JLC. Atiendes a personas interesadas en trabajar con la empresa.',

			datos: `Actualmente no hay un listado de vacantes cargado en el sistema.
Para postularse, el candidato puede enviar su hoja de vida al correo de RRHH de la empresa o entregarla en el punto físico.
Datos a recolectar del interesado: nombre completo, cargo de interés y ciudad.`,

			flujo: `1. Agradece el interés en trabajar en JLC.
2. Explica que en este momento no tienes un listado de vacantes cargado, pero puedes registrar su interés.
3. Pide nombre completo, cargo de interés y ciudad.
4. Indica que puede enviar su hoja de vida para quedar en base de datos.`,

			reglas: `- Máximo 70 palabras.
- Tono cordial y motivador.
- Sin asteriscos ni listas con símbolos.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'vacantes' },
		};
	}
}

// ─── AGENTE DISTRIBUIDORES ───────────────────────────────────────────────────

export class DistribuidoresAgent implements IAgent {
	name = 'Distribuidores';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente del programa de distribuidores de Electrodomésticos JLC. Atiendes a personas o empresas que quieren ser distribuidores autorizados.',

			datos: `Datos que debe entregar el aspirante a distribuidor:
- NIT
- Nombre o razón social
- Teléfono de contacto
- Correo electrónico
- Rango de importe de ventas estimado
- Departamento
- Ciudad`,

			flujo: `1. Da la bienvenida al programa de distribuidores.
2. Explica brevemente que para evaluar la solicitud necesitas algunos datos.
3. Pide los datos en grupos pequeños: primero NIT, nombre o razón social y ciudad; luego teléfono y correo; luego rango de ventas.
4. No pidas todo de golpe: avanza un paso a la vez según ya haya respondido.`,

			reglas: `- Máximo 60 palabras.
- Tono profesional y motivador.
- Sin asteriscos ni listas con símbolos.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'distribuidores' },
		};
	}
}

// ─── AGENTE MEDIOS DE PAGO ───────────────────────────────────────────────────

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de medios de pago de Electrodomésticos JLC. Ayudas al cliente a saber cómo pagar su compra.',

			datos: `Opciones de pago:
- En línea: el cliente selecciona el artículo en https://jlc-electronics.com/ y elige medio de pago al finalizar la compra.
- En punto físico: pago directo en la tienda.
- Para crédito: lo gestiona Cristina al WhatsApp +57 318 740 8190.`,

			flujo: `1. Pregunta qué artículo quiere comprar (si aún no lo dijo).
2. Explica las opciones de pago: en línea desde la página web o pago en punto físico.
3. Comparte el enlace https://jlc-electronics.com/ para que pueda seleccionar el producto y proceder al pago.
4. Si menciona crédito, redirígelo a Cristina (+57 318 740 8190).
5. Pide que confirme cuando haya realizado el pago para coordinar la entrega.`,

			reglas: `- Máximo 70 palabras.
- Tono claro y útil.
- Sin asteriscos ni listas con símbolos.`,

			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'pagos' },
		};
	}
}