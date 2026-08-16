type LruEntry<V> = { hardExpiry: number; softExpiry: number; value: V }

type LruMeta<V> = { stale: boolean; value: V }

/**
 * LRU (Least Recently Used) cache with optional TTL + Stale-While-Revalidate support.
 * Bounds cache size and auto-evicts stale entries.
 *
 * When hardTtlMs is set, getWithMeta() returns stale entries between soft and hard expiry
 * so callers can serve stale data while revalidating in the background.
 */
class LruCache<K, V> {
	private cache: Map<K, LruEntry<V>>
	private readonly hardTtlMs: number | undefined
	private readonly maxSize: number
	private readonly ttlMs: number | undefined

	/**
	 * @param maxSize - Maximum number of entries
	 * @param ttlMs - Soft TTL: entry considered stale after this (used by get())
	 * @param hardTtlMs - Hard TTL: entry fully evicted after this (used by getWithMeta())
	 */
	constructor(options: { hardTtlMs?: number; maxSize: number; ttlMs?: number }) {
		this.maxSize = options.maxSize
		this.ttlMs = options.ttlMs
		this.hardTtlMs = options.hardTtlMs
		this.cache = new Map()
	}

	/**
	 * Get value from cache.
	 * Returns undefined if not found or past soft expiry.
	 * Updates access order (LRU).
	 */
	get(key: K): V | undefined {
		const entry = this.cache.get(key)

		if (!entry) {
			return undefined
		}

		if (Number.isFinite(entry.softExpiry) && Date.now() > entry.softExpiry) {
			if (Number.isFinite(entry.hardExpiry) && Date.now() > entry.hardExpiry) {
				this.cache.delete(key)
			}
			return undefined
		}

		/* move to end (most recently used) by deleting and re-inserting */
		this.cache.delete(key)
		this.cache.set(key, entry)

		return entry.value
	}

	/**
	 * Get value with staleness metadata for SWR pattern.
	 * - Before softExpiry: { value, stale: false }
	 * - Between soft and hardExpiry: { value, stale: true }
	 * - After hardExpiry or not found: undefined
	 *
	 * When hardTtlMs not configured, behaves like get() wrapped in meta.
	 */
	getWithMeta(key: K): LruMeta<V> | undefined {
		const entry = this.cache.get(key)

		if (!entry) {
			return undefined
		}

		const now = Date.now()

		/* Hard eviction check */
		if (Number.isFinite(entry.hardExpiry) && now > entry.hardExpiry) {
			this.cache.delete(key)
			return undefined
		}

		/* move to end (most recently used) */
		this.cache.delete(key)
		this.cache.set(key, entry)

		const stale = Number.isFinite(entry.softExpiry) && now > entry.softExpiry
		return { stale, value: entry.value }
	}

	/**
	 * Set value in cache.
	 * Evicts oldest entry if at max size.
	 * @param ttlMs - Optional per-key soft TTL override
	 */
	set(key: K, value: V, ttlMs?: number): void {
		/* remove if exists (to update position) */
		this.cache.delete(key)

		/* evict oldest entry if at max size */
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value
			if (firstKey !== undefined) {
				this.cache.delete(firstKey)
			}
		}

		const effectiveSoftTtl = ttlMs ?? this.ttlMs
		const now = Date.now()
		const softExpiry = effectiveSoftTtl ? now + effectiveSoftTtl : Number.POSITIVE_INFINITY
		const hardExpiry = this.hardTtlMs ? now + this.hardTtlMs : softExpiry

		this.cache.set(key, { hardExpiry, softExpiry, value })
	}

	/** Delete key from cache */
	delete(key: K): boolean {
		return this.cache.delete(key)
	}

	/** Clear all entries */
	clear(): void {
		this.cache.clear()
	}

	/** Get current cache size */
	get size(): number {
		return this.cache.size
	}

	/** Check if key exists and is not past soft expiry */
	has(key: K): boolean {
		const entry = this.cache.get(key)

		if (!entry) {
			return false
		}

		if (Number.isFinite(entry.softExpiry) && Date.now() > entry.softExpiry) {
			if (Number.isFinite(entry.hardExpiry) && Date.now() > entry.hardExpiry) {
				this.cache.delete(key)
			}
			return false
		}

		return true
	}
}

export { LruCache, type LruMeta }
