CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`peer_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text,
	`content` text NOT NULL,
	`mentions_bot` integer DEFAULT false NOT NULL,
	`mentions` text,
	`quoted_content` text,
	`msg_idx` text,
	`quoted_msg_idx` text,
	`attachments` text,
	`raw_event_type` text NOT NULL,
	`timestamp` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_bindings` (
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`peer_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	CONSTRAINT `session_bindings_pk` PRIMARY KEY(`app_id`, `scope`, `peer_id`, `epoch`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_msgid` ON `messages` (`app_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_peer_ts` ON `messages` (`app_id`,`peer_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_messages_msgidx` ON `messages` (`app_id`,`peer_id`,`msg_idx`);--> statement-breakpoint
CREATE INDEX `idx_bindings_current` ON `session_bindings` (`app_id`,`scope`,`peer_id`,`is_current`);