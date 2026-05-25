import { GoogleGenerativeAI } from '@google/generative-ai';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';
import type { WCProduct } from '../woocommerce/woocommerce.service.js';
import logger from '../utils/logger.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

interface IndexedProduct {
	product: WCProduct;
	vector: number[];
}

let index: IndexedProduct[] = [];
let indexReady = false;

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function buildProductText(p: WCProduct): string {
	const cats = (p.categories || []).map((c: any) => c.name).filter(Boolean).join(', ');
	return `${p.name}${cats ? ', ' + cats : ''}${p.short_description ? '. ' + p.short_description.replace(/<[^>]+>/g, '') : ''}${p.description ? '. ' + p.description.replace(/<[^>]+>/g, '') : ''}`;
}

async function getEmbedding(text: string): Promise<number[]> {
	const models = [
		'gemini-embedding-2',
		'models/text-embedding-004',
		'models/embedding-001',
	];
	let lastError: any;

	for (const modelName of models) {
		try {
			const model = genAI.getGenerativeModel({ model: modelName });
			const result = await model.embedContent(text);
			return result.embedding.values;
		} catch (error: any) {
			lastError = error;
		}
	}
	throw new Error(`Embedding falló. Último error: ${lastError?.message}`);
}

export async function buildIndex(): Promise<void> {
	try {
		logger.info('VectorStore: Indexando productos...');

		// Cargar desde WooCommerce
		let products: WCProduct[] = [];
		try {
			products = await wooCommerceService.getProducts(100);
		} catch {
			products = [];
		}

		if (!products || products.length === 0) {
			// Usar búsqueda como fallback para obtener productos
			const queries = ['nevera', 'televisor', 'lavadora', 'congelador', 'horno', 'licuadora', 'cafetera', 'ventilador', 'freidora', 'sonido'];
			const results = await Promise.allSettled(queries.map(q => wooCommerceService.searchProducts(q, 10)));
			const allMap = new Map<number, WCProduct>();
			for (const r of results) {
				if (r.status === 'fulfilled') {
					for (const p of r.value) allMap.set(p.id, p);
				}
			}
			products = [...allMap.values()];
		}

		if (!products || products.length === 0) {
			logger.warn('VectorStore: No se encontraron productos para indexar');
			return;
		}

		logger.info({ total: products.length }, 'VectorStore: Productos cargados, generando embeddings...');

		// Embedding en lote con concurrencia limitada
		const batchSize = 5;
		const results: IndexedProduct[] = [];

		for (let i = 0; i < products.length; i += batchSize) {
			const batch = products.slice(i, i + batchSize);
			const embeddings = await Promise.allSettled(
				batch.map(p => getEmbedding(buildProductText(p)))
			);

			for (let j = 0; j < batch.length; j++) {
				const e = embeddings[j];
				if (e.status === 'fulfilled') {
					results.push({ product: batch[j], vector: e.value });
				} else {
					logger.warn({ product: batch[j].name }, 'VectorStore: embedding falló para producto');
				}
			}

			if (i + batchSize < products.length) {
				// Pequeña pausa para no saturar la API
				await new Promise(r => setTimeout(r, 200));
			}
		}

		index = results;
		indexReady = true;
		logger.info({ indexados: results.length }, 'VectorStore: Indexación completada');
	} catch (error: any) {
		logger.error({ error: error?.message }, 'VectorStore: Error en indexación');
	}
}

export async function searchByVector(
	query: string,
	limit = 6
): Promise<{ product: WCProduct; score: number }[]> {
	if (!indexReady || index.length === 0) {
		// Fallback a WooCommerce search
		const products = await wooCommerceService.searchProducts(query, limit);
		return products.map(p => ({ product: p, score: 0 }));
	}

	try {
		const queryVector = await getEmbedding(query);
		const scored = index
			.map((item) => ({
				product: item.product,
				score: cosineSimilarity(queryVector, item.vector),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		return scored;
	} catch {
		// Fallback
		const products = await wooCommerceService.searchProducts(query, limit);
		return products.map(p => ({ product: p, score: 0 }));
	}
}

export function isIndexReady(): boolean {
	return indexReady;
}
