import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require('whatsapp-web.js');
import qrcode from 'qrcode';
import logger from '../utils/logger.js';
import { handleIncomingMessage } from './message.handler.js';

let whatsappClient: Client | null = null;
let currentQR: string | null = null;
let isReady = false;

export type WAStatus = 'disconnected' | 'qr_pending' | 'connected';

export const getStatus = (): WAStatus => {
	if (isReady) return 'connected';
	if (currentQR) return 'qr_pending';
	return 'disconnected';
};

export const getCurrentQR = (): string | null => currentQR;

export const initWhatsApp = async (): Promise<Client | null> => {
	try {
		const chromePath =
			process.env.CHROME_PATH ||
			'C:\\Users\\Niok\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe';

		logger.info({ chromePath }, 'Initializing WhatsApp with Chrome');

		const client = new Client({
			authStrategy: new LocalAuth({
				dataPath: './wa_session',
				clientId: 'nexia-crm-client',
			}),
			webVersionCache: {
				type: 'remote',
				remotePath:
					'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
			},
			puppeteer: {
				headless: true,
				executablePath: chromePath,
				args: [
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--no-first-run',
					'--disable-setuid-sandbox',
					'--no-sandbox',
				],
			},
		});

		client.on('qr', async (qr) => {
			logger.info('QR Code received. Scan with WhatsApp.');
			currentQR = qr;
			isReady = false;

			// También imprimir en terminal para desarrollo
			qrcode.toString(qr, { type: 'terminal' }, (err, url) => {
				if (!err) console.log(url);
			});
		});

		client.on('ready', () => {
			logger.info('WhatsApp is ready!');
			isReady = true;
			currentQR = null;
		});

		client.on('authenticated', () => {
			logger.info('WhatsApp authenticated');
			currentQR = null;
		});

		client.on('auth_failure', (msg) => {
			logger.error({ msg }, 'WhatsApp authentication failed');
			isReady = false;
		});

		client.on('disconnected', (reason) => {
			logger.warn({ reason }, 'WhatsApp disconnected');
			isReady = false;
			currentQR = null;
		});

		// Conectar mensajes entrantes al handler
		client.on('message', handleIncomingMessage);

		await client.initialize();
		whatsappClient = client;
		return client;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error({ error: msg }, 'Failed to initialize WhatsApp');
		return null;
	}
};

export const getWhatsAppClient = (): Client | null => whatsappClient;

export const sendMessage = async (to: string, message: string): Promise<void> => {
	if (!whatsappClient) {
		throw new Error('WhatsApp client not initialized');
	}
	const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
	await whatsappClient.sendMessage(chatId, message);
};
