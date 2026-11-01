/** A reader found no database to open: a read-only connect creates none (S3 of the r18 review) */
export class DatabaseMissing extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DatabaseMissing"
	}
}
