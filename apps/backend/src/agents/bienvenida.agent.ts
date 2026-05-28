import { IAgent, AgentResponse } from './types.js';
import { getSaludo, AGENT_NAME } from './helpers.js';

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

	private tieneIntencionClara(mensaje: string): boolean {
		const keywords = [
			'nevera', 'televisor', 'tv', 'lavadora', 'congelador', 'parlante',
			'precio', 'cotizar', 'cuánto', 'cuanto', 'comprar', 'garantía',
			'garantia', 'técnico', 'tecnico', 'distribuidor', 'trabajo', 'vacante',
			'pago', 'crédito', 'credito', 'envío', 'envio', 'repuesto', 'cartera',
			'cuota', 'deuda',
		];
		const lower = mensaje.toLowerCase();
		return keywords.some((kw) => lower.includes(kw));
	}

	private esClienteRecurrente(context: any): boolean {
		return context?.nuevaSesion || (context?.history?.length ?? 0) > 0;
	}

	async handle(message: string, context: any): Promise<AgentResponse> {
		const saludo = getSaludo();
		const recurrente = this.esClienteRecurrente(context);
		const tieneIntencion = this.tieneIntencionClara(message);

		// Cliente recurrente: mensaje cálido de bienvenida de regreso
		if (recurrente && !tieneIntencion) {
			return {
				response: `¡${saludo}! Qué gusto tenerte de nuevo por aquí. 😊 ¿En qué te puedo ayudar el día de hoy?`,
				metadata: {
					agentType: 'bienvenida',
					passthrough: true,
				},
			};
		}

		// Si el usuario ya llegó con una intención clara, bienvenida breve
		if (tieneIntencion) {
			return {
				response: `${saludo} 👋 Soy ${AGENT_NAME}, asistente virtual de JLC Electronics. Con gusto te ayudo con eso.`,
				metadata: {
					agentType: 'bienvenida',
					passthrough: true,
				},
			};
		}

		// Bienvenida completa con menú organizado para primera vez
		const menu = `${saludo} 👋 Soy ${AGENT_NAME}, tu asesora virtual en JLC Electronics.

¿En qué te puedo ayudar?

1️⃣ Comprar un producto (contado o crédito)
2️⃣ Cartera / estado de cuenta
3️⃣ Servicio técnico o garantía
4️⃣ Repuestos
5️⃣ Medios de pago / pagar una cuota
6️⃣ Distribuidores
7️⃣ Trabaja con nosotros

Escríbeme el número o cuéntame qué necesitas 😊`;

		return {
			response: menu,
			metadata: { agentType: 'bienvenida', passthrough: false },
		};
	}
}
