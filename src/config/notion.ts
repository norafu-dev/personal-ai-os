export const NOTION_CONFIG = {
	// AI OS 根页面
	rootPageId: '3f55fa82-8159-80d0-98c8-f2dc698197e7',

	// 允许 AI 管理的 Data Source
	managedDataSourceIds: new Set<string>([
		// Personal Operating Manual
		'3fc5fa82-8159-8014-bcba-000b36d2800b',

		// Calendar
		'3f55fa82-8159-804f-bf8d-000bee7f9a71',

		// Tasks
		'3f55fa82-8159-80c2-bc75-000b36a2490e',

		// Bookmarks
		'29f5fa82-8159-8184-ab6a-000b5b87554b',

		// AI 协作队列
		'95af6fad-798f-4d0a-b370-356646a5745d',
	]),
};
