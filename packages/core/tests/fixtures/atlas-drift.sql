PRAGMA defer_foreign_keys = on;
-- Create "new_post" table
CREATE TABLE `new_post` (
  `id` text NOT NULL,
  `author_id` text NULL,
  `slug` text NOT NULL,
  `title` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft',
  `published_at` integer NULL,
  `created_at` integer NOT NULL DEFAULT 0,
  `updated_at` integer NOT NULL DEFAULT 0,
  `deleted_at` integer NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `post_author_id_fk` FOREIGN KEY (`author_id`) REFERENCES `author` (`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `post_status_check` CHECK (`status` IN ('draft', 'scheduled', 'published'))
);
-- Copy rows from old table "post" to new temporary table "new_post"
INSERT INTO `new_post` (`id`, `author_id`, `slug`, `title`, `status`, `published_at`, `created_at`, `updated_at`, `deleted_at`)
SELECT `id`, `author_id`, IFNULL(`slug`, `id`), IFNULL(`title`, ''), IFNULL(`status`, 'draft'), `published_at`, IFNULL(`created_at`, 0), IFNULL(`updated_at`, 0), `deleted_at` FROM `post`;
-- Drop "post" table after copying rows
DROP TABLE `post`;
-- Rename temporary table "new_post" to "post"
ALTER TABLE `new_post` RENAME TO `post`;
-- Create index "idx_post_slug" to table: "post"
CREATE UNIQUE INDEX `idx_post_slug` ON `post` (`slug`);
-- Create index "idx_post_author_id" to table: "post"
CREATE INDEX `idx_post_author_id` ON `post` (`author_id`);
-- Create index "idx_post_published" to table: "post"
CREATE INDEX `idx_post_published` ON `post` (`status`, `published_at`);
-- Create index "idx_post_deleted_at" to table: "post"
CREATE INDEX `idx_post_deleted_at` ON `post` (`deleted_at`);
-- Add column "locale" to table: "comment"
ALTER TABLE `comment` ADD COLUMN `locale` text NULL;
-- Create "new_comment" table
CREATE TABLE `new_comment` (
  `id` text NOT NULL,
  `post_id` text NOT NULL,
  `body` text NOT NULL DEFAULT '',
  `locale` text NULL,
  `created_at` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  CONSTRAINT `comment_post_id_fk` FOREIGN KEY (`post_id`) REFERENCES `post` (`id`) ON UPDATE no action ON DELETE cascade
);
-- Copy rows from old table "comment" to new temporary table "new_comment"
INSERT INTO `new_comment` (`id`, `post_id`, `body`, `locale`, `created_at`)
SELECT `id`, IFNULL(`post_id`, ''), IFNULL(`body`, ''), `locale`, IFNULL(`created_at`, 0) FROM `comment`;
-- Drop "comment" table after copying rows
DROP TABLE `comment`;
-- Rename temporary table "new_comment" to "comment"
ALTER TABLE `new_comment` RENAME TO `comment`;
-- Create index "idx_comment_post_id" to table: "comment"
CREATE INDEX `idx_comment_post_id` ON `comment` (`post_id`);
-- Create "tag" table
CREATE TABLE `tag` (
  `id` text NOT NULL,
  `slug` text NOT NULL,
  `created_at` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
);
-- Create index "idx_tag_slug" to table: "tag"
CREATE UNIQUE INDEX `idx_tag_slug` ON `tag` (`slug`);
-- Create "post_tag" table
CREATE TABLE `post_tag` (
  `post_id` text NOT NULL,
  `tag_id` text NOT NULL,
  PRIMARY KEY (`post_id`, `tag_id`),
  CONSTRAINT `post_tag_post_id_fk` FOREIGN KEY (`post_id`) REFERENCES `post` (`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `post_tag_tag_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tag` (`id`) ON UPDATE no action ON DELETE cascade
);
-- Create index "idx_post_tag_tag_id" to table: "post_tag"
CREATE INDEX `idx_post_tag_tag_id` ON `post_tag` (`tag_id`);
-- Create "post_translation" table
CREATE TABLE `post_translation` (
  `post_id` text NOT NULL,
  `locale` text NOT NULL,
  `title` text NOT NULL,
  `body` text NULL,
  PRIMARY KEY (`post_id`, `locale`),
  CONSTRAINT `post_translation_post_id_fk` FOREIGN KEY (`post_id`) REFERENCES `post` (`id`) ON UPDATE no action ON DELETE cascade
);
