/* an expiry is a time, or Infinity for an entry that never expires: `now > Infinity` is never true */
type LruEntry<V> = { hardExpiry: number; softExpiry: number; value: V }

type LruMeta<V> = { stale: boolean; value: V }

/**
 * LRU (Least Recently Used) cache with optional TTL + Stale-While-Revalidate support.
 * Bounds cache size and auto-evicts stale entries.
 *
 * When hardTtlMs is set, getWithMeta() returns stale entries between soft and hard expiry
 * so callers can serve stale data while revalidating in the background.
 */
const isPositive = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value > 0)

/**
 * A size that bounds the cache, and TTLs that expire: NaN or 0 would make it unbounded or
 * never-expiring, and a hard TTL under the soft one would have get() and getWithMeta() disagree.
 */
function checkOptions({ hardTtlMs, maxSize, ttlMs }: { hardTtlMs?: number; maxSize: number; ttlMs?: number }): void {
	if (!Number.isInteger(maxSize) || maxSize < 1) {
		throw new RangeError(`LruCache maxSize must be a positive integer, got ${maxSize}`)
	}
	if (!isPositive(ttlMs) || !isPositive(hardTtlMs))
		throw new RangeError("LruCache ttlMs and hardTtlMs must be positive")
	if (ttlMs !== undefined && hardTtlMs !== undefined && hardTtlMs < ttlMs) {
		throw new RangeError(`LruCache hardTtlMs (${hardTtlMs}) must not be shorter than ttlMs (${ttlMs})`)
	}
}

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
		checkOptions(options)
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

		if (Date.now() > entry.softExpiry) {
			if (Date.now() > entry.hardExpiry) {
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
		if (now > entry.hardExpiry) {
			this.cache.delete(key)
			return undefined
		}

		/* move to end (most recently used) */
		this.cache.delete(key)
		this.cache.set(key, entry)

		const stale = now > entry.softExpiry
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
			/* a full cache holds at least one entry, so there is a first key */
			this.cache.delete(this.cache.keys().next().value as K)
		}

		if (!isPositive(ttlMs)) throw new RangeError(`LruCache ttlMs must be positive, got ${ttlMs}`)
		/* a soft TTL past the hard one would let get serve what getWithMeta has already evicted */
		const requested = ttlMs ?? this.ttlMs
		const effectiveSoftTtl =
			requested !== undefined && this.hardTtlMs !== undefined ? Math.min(requested, this.hardTtlMs) : requested
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

		if (Date.now() > entry.softExpiry) {
			if (Date.now() > entry.hardExpiry) {
				this.cache.delete(key)
			}
			return false
		}

		return true
	}
}

export { LruCache, type LruMeta }
