const mockRegisterTaskAsync = jest.fn<Promise<void>, [string, object?]>(async () => {});
const mockTriggerTaskWorkerForTestingAsync = jest.fn<Promise<void>, []>(async () => {});

jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}));

jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: {
    Success: 1,
    Failed: 2,
  },
  registerTaskAsync: (taskName: string, options?: object) => mockRegisterTaskAsync(taskName, options),
  triggerTaskWorkerForTestingAsync: () => mockTriggerTaskWorkerForTestingAsync(),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
}));

import {
  BACKGROUND_TASK_NAME,
  registerBackgroundTaskAsync,
  triggerBackgroundTaskForTestingAsync,
} from '@/services/background/backgroundSyncTask';

describe('background task helpers', () => {
  beforeEach(() => {
    mockRegisterTaskAsync.mockClear();
    mockTriggerTaskWorkerForTestingAsync.mockClear();
  });

  it('registers the simple background task with the docs-style helper', async () => {
    await expect(registerBackgroundTaskAsync()).resolves.toBe(true);

    expect(mockRegisterTaskAsync).toHaveBeenCalledWith(BACKGROUND_TASK_NAME, undefined);
  });

  it('triggers Expo background task testing in development', async () => {
    await expect(triggerBackgroundTaskForTestingAsync()).resolves.toBe(true);

    expect(mockTriggerTaskWorkerForTestingAsync).toHaveBeenCalledTimes(1);
  });
});
