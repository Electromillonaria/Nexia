import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

export interface JwtPayload {
	sub: string;
	username: string;
	role: 'admin' | 'agent' | 'viewer';
	iat?: number;
	exp?: number;
}

interface AuthConfig {
	algorithm: 'RS256' | 'HS256';
	signingKey: string | Buffer;
	verifyKey: string | Buffer;
}

function loadKeys(): AuthConfig {
	const useRs256 = process.env.JWT_ALGORITHM?.toUpperCase() === 'RS256';

	if (useRs256) {
		const privateKeyPath = process.env.JWT_PRIVATE_KEY_PATH;
		const publicKeyPath = process.env.JWT_PUBLIC_KEY_PATH;

		let privateKey: string | Buffer = '';
		let publicKey: string | Buffer = '';

		if (privateKeyPath && fs.existsSync(privateKeyPath)) {
			privateKey = fs.readFileSync(privateKeyPath);
		} else if (process.env.JWT_PRIVATE_KEY) {
			privateKey = process.env.JWT_PRIVATE_KEY;
		} else {
			throw new Error('RS256: JWT_PRIVATE_KEY o JWT_PRIVATE_KEY_PATH requerido');
		}

		if (publicKeyPath && fs.existsSync(publicKeyPath)) {
			publicKey = fs.readFileSync(publicKeyPath);
		} else if (process.env.JWT_PUBLIC_KEY) {
			publicKey = process.env.JWT_PUBLIC_KEY;
		} else {
			throw new Error('RS256: JWT_PUBLIC_KEY o JWT_PUBLIC_KEY_PATH requerido');
		}

		console.log('🔐 Usando JWT RS256 (producción)');
		return {
			algorithm: 'RS256',
			signingKey: privateKey,
			verifyKey: publicKey,
		};
	}

	const hsSecret = process.env.JWT_SECRET || 'changeme_secret_key_dev';
	console.log('🔐 Usando JWT HS256 (desarrollo)');
	return {
		algorithm: 'HS256',
		signingKey: hsSecret,
		verifyKey: hsSecret,
	};
}

let authConfig: AuthConfig;

function getConfig(): AuthConfig {
	if (!authConfig) {
		authConfig = loadKeys();
	}
	return authConfig;
}

export const authService = {
	/**
	 * Genera un par de claves RSA para desarrollo.
	 * Guardar en archivos y usar en producción.
	 */
	generateKeyPair(): { privateKey: string; publicKey: string } {
		const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		return { privateKey, publicKey };
	},

	/**
	 * Verifica credenciales y retorna un JWT firmado.
	 */
	login(username: string, password: string): string | null {
		if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
			return null;
		}

		const config = getConfig();
		const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
			sub: 'admin-001',
			username,
			role: 'admin',
		};

		return jwt.sign(payload, config.signingKey, {
			algorithm: config.algorithm,
			expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
		});
	},

	/**
	 * Verifica y decodifica un JWT. Lanza error si es inválido.
	 */
	verify(token: string): JwtPayload {
		const config = getConfig();
		return jwt.verify(token, config.verifyKey, {
			algorithms: [config.algorithm],
		}) as JwtPayload;
	},

	/**
	 * Genera un nuevo token a partir de un payload existente.
	 */
	refresh(payload: JwtPayload): string {
		const config = getConfig();
		const { sub, username, role } = payload;
		return jwt.sign({ sub, username, role }, config.signingKey, {
			algorithm: config.algorithm,
			expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
		});
	},

	/**
	 * Obtiene la clave pública para verificar tokensexternos (opcional).
	 */
	getPublicKey(): string | Buffer | null {
		const config = getConfig();
		return config.algorithm === 'RS256' ? config.verifyKey : null;
	},

	/**
	 * Retorna el algoritmo actual (útil para debugging).
	 */
	getAlgorithm(): 'RS256' | 'HS256' {
		return getConfig().algorithm;
	},
};