import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

export const BACKGROUND_TASK_NAME = 'btwearable-background-task';

// Define the task in the global scope so Expo can find it when the worker starts.
TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
  try {
    const now = Date.now();
    console.log(`Got background task call at date: ${new Date(now).toISOString()}`);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    console.error('Failed to execute the background task:', error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundTaskAsync() {
  if (Platform.OS !== 'ios') {
    return false;
  }

  await BackgroundTask.registerTaskAsync(BACKGROUND_TASK_NAME);
  return true;
}

export async function triggerBackgroundTaskForTestingAsync() {
  if (!__DEV__) {
    return false;
  }

  await BackgroundTask.triggerTaskWorkerForTestingAsync();
  return true;
}
