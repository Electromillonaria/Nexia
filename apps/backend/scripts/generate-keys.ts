#!/usr/bin/env npx tsx

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const keysDir = path.join(process.cwd(), 'keys');

if (!fs.existsSync(keysDir)) {
	fs.mkdirSync(keysDir, { recursive: true });
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(path.join(keysDir, 'private.pem'), privateKey);
fs.writeFileSync(path.join(keysDir, 'public.pem'), publicKey);

console.log('✅ Claves RSA generadas en:');
console.log(`   - ${path.join(keysDir, 'private.pem')}`);
console.log(`   - ${path.join(keysDir, 'public.pem')}`);
console.log('');
console.log('📝 Para usar RS256, añade a tu .env:');
console.log('   JWT_ALGORITHM=RS256');
console.log('   JWT_PRIVATE_KEY_PATH=./keys/private.pem');
console.log('   JWT_PUBLIC_KEY_PATH=./keys/public.pem');
console.log('');
console.log('⚠️  IMPORTANTE: Añade "keys/" a tu .gitignore');