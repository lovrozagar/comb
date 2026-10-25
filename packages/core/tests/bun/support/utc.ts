/* bun test runs in UTC unless TZ is set; pin it, as the vitest configs do, so every run matches CI's runners */
process.env.TZ = "UTC"
