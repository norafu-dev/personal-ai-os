export const NOTION_CONFIG = {
	// AI OS 根页面
	rootPageId: '3f55fa82-8159-80d0-98c8-f2dc698197e7',

	// MCP 任务工具读写的 Data Source（AI 协作队列）
	tasksDataSourceId: '95af6fad-798f-4d0a-b370-356646a5745d',

	// MCP 日程工具读写的 Data Source（日程）
	calendarDataSourceId: '3f55fa82-8159-804f-bf8d-000bee7f9a71',

	// Nora 所在时区，用于把纯日期解释为当地零点
	utcOffset: '+09:00',

	// 允许 AI 管理的 Data Source
	managedDataSourceIds: new Set<string>([
		// Personal Operating Manual
		'3fc5fa82-8159-8014-bcba-000b36d2800b',

		// Calendar（日程）
		'3f55fa82-8159-804f-bf8d-000bee7f9a71',

		// 项目库
		'3f55fa82-8159-80c2-bc75-000b36a2490e',

		// Bookmarks
		'29f5fa82-8159-8184-ab6a-000b5b87554b',

		// AI 协作队列
		'95af6fad-798f-4d0a-b370-356646a5745d',
	]),
};
