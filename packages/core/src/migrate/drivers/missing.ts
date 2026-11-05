// S3 of the r18 review
/**
 * What a read-only connect, as `comb migrate check` and `status` make, throws for a database that is
 * not there, since it creates none; its name is `DatabaseMissing`
 */
export class DatabaseMissing extends Error {
	/** an error whose message says which database is missing */
	constructor(message: string) {
		super(message)
		this.name = "DatabaseMissing"
	}
}
