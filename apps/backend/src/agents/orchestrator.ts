import {
	IAgent,
	VentasAgent,
	CarteraAgent,
	ServicioTecnicoAgent,
	RepuestosAgent,
	VacantesAgent,
	DistribuidoresAgent,
	PagosAgent,
} from './agents.js';
import { generateResponse } from '../utils/gemini.js';

type IntentKey =
	| 'ventas'
	| 'cartera'
	| 'servicio_tecnico'
	| 'repuestos'
	| 'vacantes'
	| 'distribuidores'
	| 'pagos';

export class Orchestrator {
	private agents: Record<IntentKey, IAgent> = {
		ventas: new VentasAgent(),
		cartera: new CarteraAgent(),
		servicio_tecnico: new ServicioTecnicoAgent(),
		repuestos: new RepuestosAgent(),
		vacantes: new VacantesAgent(),
		distribuidores: new DistribuidoresAgent(),
		pagos: new PagosAgent(),
	};

	// ─── Atajo por palabras clave (rápido, sin llamar al modelo) ──────────────
	//
	// Gemma a veces falla la clasificación con mensajes muy cortos o ambiguos.
	// Si el mensaje tiene palabras claves obvias, las atajamos aquí.

	private quickIntent(message: string): IntentKey | null {
		const m = message.toLowerCase();

		// Distribuidores
		if (/\b(distribuidor|distribuidores|ser distribuidor|al por mayor|mayorista|mayoreo)\b/.test(m)) {
			return 'distribuidores';
		}
		// Vacantes / empleo
		if (/\b(vacante|empleo|trabajo|hoja de vida|cv|curriculum|currículum|aplicar a)\b/.test(m)) {
			return 'vacantes';
		}
		// Servicio técnico
		if (/\b(servicio t[eé]cnico|reparaci[oó]n|reparar|mantenimiento|no enciende|no funciona|da[ñn]ado|falla|aver[ií]a|garant[ií]a)\b/.test(m)) {
			return 'servicio_tecnico';
		}
		// Repuestos
		if (/\b(repuesto|repuestos|pieza|piezas|accesorio|accesorios)\b/.test(m)) {
			return 'repuestos';
		}
		// Cartera
		if (/\b(cartera|deuda|mora|cuota|cuotas|atrasado|estado de cuenta|saldo|recordatorio de pago)\b/.test(m)) {
			return 'cartera';
		}
		// Medios de pago (intención de pagar AHORA, no preguntar por deuda)
		if (/\b(c[oó]mo pago|d[oó]nde pago|medio de pago|medios de pago|formas de pago|pse|tarjeta|transferencia|consignar|consignaci[oó]n)\b/.test(m)) {
			return 'pagos';
		}
		// Ventas
		if (/\b(comprar|cotizar|cotizaci[oó]n|precio|cu[aá]nto cuesta|cu[aá]nto vale|nevera|lavadora|televisor|tv|estufa|microondas|licuadora|aire acondicionado|electrodom[eé]stico)\b/.test(m)) {
			return 'ventas';
		}

		return null;
	}

	async classifyIntent(message: string): Promise<IntentKey> {
		// 1. Atajo por palabras clave
		const quick = this.quickIntent(message);
		if (quick) return quick;

		// 2. Clasificación con el modelo (formato few-shot, Gemma-friendly)
		const classificationPrompt = `Eres un clasificador. Tu única tarea es leer un mensaje de un cliente y responder con UNA SOLA palabra entre estas siete opciones:

ventas | cartera | servicio_tecnico | repuestos | vacantes | distribuidores | pagos

Significado de cada categoría:
- ventas: quiere comprar, cotizar o pedir información de un electrodoméstico.
- cartera: pregunta por su deuda, cuotas, estado de cuenta o recordatorio de pago.
- servicio_tecnico: tiene un electrodoméstico dañado, con falla o necesita mantenimiento.
- repuestos: busca un repuesto, pieza o accesorio.
- vacantes: pregunta por trabajo, empleo o quiere enviar hoja de vida.
- distribuidores: quiere ser distribuidor o comprar al por mayor.
- pagos: pregunta cómo pagar, medios de pago o dónde pagar.

Ejemplos:

Mensaje: "Hola, quiero saber el precio de una nevera de 300 litros"
Categoría: ventas

Mensaje: "Mi lavadora no centrifuga, ¿pueden revisarla?"
Categoría: servicio_tecnico

Mensaje: "Necesito el filtro de mi nevera marca Mabe"
Categoría: repuestos

Mensaje: "¿Cuánto debo de mi crédito?"
Categoría: cartera

Mensaje: "¿Tienen vacantes para asesor comercial?"
Categoría: vacantes

Mensaje: "Quiero ser distribuidor en Cali"
Categoría: distribuidores

Mensaje: "¿Puedo pagar con tarjeta de crédito?"
Categoría: pagos

Ahora clasifica este mensaje. Responde SOLO la palabra de la categoría, nada más.

Mensaje: "${message.replace(/"/g, "'")}"
Categoría:`;

		let raw = '';
		try {
			raw = await generateResponse(classificationPrompt);
		} catch {
			return 'ventas';
		}

		const category = (raw || '').toLowerCase().trim();

		// 3. Matching tolerante (Gemma a veces agrega texto extra)
		if (/servicio[_ ]?t[eé]cnico|servicio|t[eé]cnico/.test(category)) return 'servicio_tecnico';
		if (/distribuidor/.test(category)) return 'distribuidores';
		if (/repuesto/.test(category)) return 'repuestos';
		if (/vacante|empleo|trabajo/.test(category)) return 'vacantes';
		if (/cartera|deuda|cuota/.test(category)) return 'cartera';
		if (/\bpago\b|pagos|medio de pago/.test(category)) return 'pagos';
		if (/venta/.test(category)) return 'ventas';

		// 4. Fallback seguro
		return 'ventas';
	}

	async route(
		message: string,
		context: any
	): Promise<{ agentType: string; response: string }> {
		const intent = await this.classifyIntent(message);
		const agent = this.agents[intent] || this.agents.ventas;

		const result = await agent.handle(message, context);

		return {
			agentType: intent,
			response: result.response,
		};
	}
}

export const orchestrator = new Orchestrator();