export const NOTIFICATION_ROUTE_KEY = 'route';

export function routeFromNotificationData(data: Record<string, unknown> | undefined | null) {
  const value = data?.[NOTIFICATION_ROUTE_KEY];
  return typeof value === 'string' ? value : null;
}
