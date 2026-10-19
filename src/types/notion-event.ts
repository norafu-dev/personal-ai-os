export const NOTION_PAGE_PROPERTIES_UPDATED = 'page.properties_updated' as const;

export type StandardNotionEvent = {
	eventId: string;
	eventType: typeof NOTION_PAGE_PROPERTIES_UPDATED;
	pageId: string;
	dataSourceId: string;
	updatedPropertyIds?: string[];
};

export type NotionWebhookParseResult =
	| {
			kind: 'accepted';
			event: StandardNotionEvent;
	  }
	| {
			kind: 'ignored';
			reason: 'unsupported_event_type' | 'unmanaged_data_source';
			eventType?: string;
			dataSourceId?: string;
	  }
	| {
			kind: 'invalid';
			reason: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function parseNotionWebhookEvent(
	value: unknown,
	managedDataSourceIds: ReadonlySet<string>,
): NotionWebhookParseResult {
	if (!isRecord(value)) {
		return { kind: 'invalid', reason: 'Event must be a JSON object' };
	}

	const eventType = value.type;

	if (!isNonEmptyString(eventType)) {
		return { kind: 'invalid', reason: 'Event type is required' };
	}

	if (eventType !== NOTION_PAGE_PROPERTIES_UPDATED) {
		return {
			kind: 'ignored',
			reason: 'unsupported_event_type',
			eventType,
		};
	}

	if (!isNonEmptyString(value.id)) {
		return { kind: 'invalid', reason: 'Event ID is required' };
	}

	if (!isRecord(value.entity) || value.entity.type !== 'page' || !isNonEmptyString(value.entity.id)) {
		return { kind: 'invalid', reason: 'A page entity is required' };
	}

	const data = value.data;
	const parent = isRecord(data) ? data.parent : undefined;
	const dataSourceId = isRecord(parent) ? parent.data_source_id : undefined;

	if (!isNonEmptyString(dataSourceId) || !managedDataSourceIds.has(dataSourceId)) {
		return {
			kind: 'ignored',
			reason: 'unmanaged_data_source',
			dataSourceId: isNonEmptyString(dataSourceId) ? dataSourceId : undefined,
		};
	}

	const updatedProperties = isRecord(data) ? data.updated_properties : undefined;

	if (updatedProperties !== undefined && (!Array.isArray(updatedProperties) || !updatedProperties.every(isNonEmptyString))) {
		return { kind: 'invalid', reason: 'Updated property IDs must be strings' };
	}

	return {
		kind: 'accepted',
		event: {
			eventId: value.id,
			eventType,
			pageId: value.entity.id,
			dataSourceId,
			...(updatedProperties === undefined ? {} : { updatedPropertyIds: [...updatedProperties] }),
		},
	};
}

export function parseStandardNotionEvent(value: unknown): StandardNotionEvent | null {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.eventId) ||
		value.eventType !== NOTION_PAGE_PROPERTIES_UPDATED ||
		!isNonEmptyString(value.pageId) ||
		!isNonEmptyString(value.dataSourceId)
	) {
		return null;
	}

	const updatedPropertyIds = value.updatedPropertyIds;

	if (updatedPropertyIds !== undefined && (!Array.isArray(updatedPropertyIds) || !updatedPropertyIds.every(isNonEmptyString))) {
		return null;
	}

	return {
		eventId: value.eventId,
		eventType: value.eventType,
		pageId: value.pageId,
		dataSourceId: value.dataSourceId,
		...(updatedPropertyIds === undefined ? {} : { updatedPropertyIds: [...updatedPropertyIds] }),
	};
}
