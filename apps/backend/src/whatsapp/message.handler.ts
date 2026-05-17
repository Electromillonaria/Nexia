import { Message } from 'whatsapp-web.js';
import prisma from '../db/index.js';
import { orchestrator } from '../agents/orchestrator.js';
import { sendMessage, getStatus } from './whatsapp.js';
import logger from '../utils/logger.js';

/**
 * Maneja cada mensaje entrante de WhatsApp:
 * 1. Busca o crea el Contact en BD
 * 2. Persiste el mensaje INBOUND
 * 3. Obtiene el historial reciente como contexto
 * 4. Enruta al orquestador de agentes IA
 * 5. Persiste la respuesta OUTBOUND
 * 6. Actualiza el Lead con la etapa y módulo correctos
 * 7. Envía la respuesta por WhatsApp
 */
export async function handleIncomingMessage(msg: Message): Promise<void> {
	logger.info({ msgFrom: msg.from, msgFromMe: msg.fromMe }, 'Message event received');

	// Ignorar mensajes del propio número
	if (msg.fromMe) {
		logger.info('Ignoring message fromMe');
		return;
	}
	// Ignorar mensajes de grupos
	if (msg.from.endsWith('@g.us')) {
		logger.info('Ignoring group message');
		return;
	}

	// Extraer número de teléfono correctamente (manejar formato lid y c.us)
	let phone = msg.from;
	if (phone.includes('@lid')) {
		// Formato legacy: 212519343923373@lid -> extraer solo números
		phone = phone.replace('@lid', '');
	} else if (phone.includes('@c.us')) {
		phone = phone.replace('@c.us', '');
	}
	const body = msg.body?.trim();

	if (!body) {
		logger.warn({ phone }, 'Empty message body, ignoring');
		return;
	}

	logger.info({ phone, body: body.slice(0, 80) }, 'Incoming WA message');

	try {
		// 1. Upsert del contacto
		const contact = await prisma.contact.upsert({
			where: { phone },
			update: {},
			create: { phone },
		});

		// 2. Persistir mensaje INBOUND
		await prisma.message.create({
			data: {
				contactId: contact.id,
				direction: 'INBOUND',
				body,
			},
		});

		// 3. Obtener historial reciente (últimos 10 mensajes)
		const history = await prisma.message.findMany({
			where: { contactId: contact.id },
			orderBy: { sentAt: 'desc' },
			take: 10,
		});

		// 4. Lead activo del contacto (el más reciente)
		let lead = await prisma.lead.findFirst({
			where: { contactId: contact.id },
			orderBy: { createdAt: 'desc' },
		});

		const context = {
			contactId: contact.id,
			phone,
			leadId: lead?.id,
			stage: lead?.stage ?? 'INITIAL',
			module: lead?.module ?? 'VENTAS',
			history: history.reverse().map((m) => ({
				direction: m.direction,
				body: m.body,
				sentAt: m.sentAt,
			})),
		};

		// 5. Enrutar al orquestador
		const { agentType, response } = await orchestrator.route(body, context);

		// 6. Persistir respuesta OUTBOUND
		await prisma.message.create({
			data: {
				contactId: contact.id,
				direction: 'OUTBOUND',
				body: response,
				agentType,
			},
		});

		// 7. Crear o actualizar lead
		const moduleMap: Record<string, string> = {
			ventas: 'VENTAS',
			cartera: 'CARTERA',
			servicio_tecnico: 'SERVICIO_TECNICO',
			repuestos: 'REPUESTOS',
			vacantes: 'VACANTES',
			distribuidores: 'DISTRIBUIDORES',
			pagos: 'MEDIOS_DE_PAGO',
		};

		const crmModule = moduleMap[agentType] ?? 'VENTAS';

		if (!lead) {
			lead = await prisma.lead.create({
				data: {
					contactId: contact.id,
					stage: 'INITIAL',
					type: 'CONSULTA',
					module: crmModule,
				},
			});
		} else if (lead.module !== crmModule) {
			// Si el módulo cambió, el orquestador reasignó al contacto
			lead = await prisma.lead.update({
				where: { id: lead.id },
				data: { module: crmModule },
			});
		}

		// 8. Enviar respuesta por WhatsApp solo si está conectado
		if (getStatus() === 'connected') {
			await sendMessage(phone, response);
			logger.info({ phone, agentType, leadId: lead.id }, 'Response sent');
		} else {
			logger.warn({ phone, agentType }, 'WhatsApp not connected, response not sent');
		}
	} catch (error) {
		logger.error({ error, phone }, 'Error handling incoming message');

		// Intentar enviar mensaje de error al usuario solo si está conectado
		if (getStatus() === 'connected') {
			try {
				await sendMessage(
					phone,
					'Lo siento, hubo un problema procesando tu mensaje. Por favor intenta de nuevo en un momento.'
				);
			} catch {
				// Si falla el envío del error, solo logueamos
			}
		}
	}
}
