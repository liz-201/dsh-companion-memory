/**
 * Only reminder tasks are exempt from spontaneous-contact limits. Open topics
 * and commitments also have task IDs, so task_id alone cannot identify them.
 * Keep the classification after a reminder is marked done; send eligibility
 * still requires its confirmed state in the worker's final recheck.
 */
export declare const SPONTANEOUS_OUTBOX = "outbox.turn_id IS NULL AND NOT EXISTS (\n  SELECT 1 FROM tasks reminder WHERE reminder.id = outbox.task_id\n  AND reminder.conversation_id = outbox.conversation_id AND reminder.kind = 'reminder'\n)";
