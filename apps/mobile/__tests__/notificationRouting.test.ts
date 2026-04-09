jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

import { routeFromNotificationData } from '@/services/notifications/notificationRouting';

describe('notification routing', () => {
  it('registers the local notification handler and extracts deep links', () => {
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(routeFromNotificationData({ route: '/sleep' })).toBe('/sleep');
    expect(routeFromNotificationData({})).toBeNull();
  });
});