import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface BackgroundExecutionAssertionNativeModule {
  begin(name: string): Promise<number>;
  end(identifier: number): Promise<void>;
}

let nativeModule: BackgroundExecutionAssertionNativeModule | null | undefined;

function getNativeModule() {
  if (Platform.OS !== 'ios') {
    return null;
  }

  nativeModule ??= requireOptionalNativeModule<BackgroundExecutionAssertionNativeModule>(
    'BackgroundExecutionAssertion',
  );
  return nativeModule;
}

export async function beginBackgroundExecutionAssertionAsync(name: string) {
  const module = getNativeModule();
  if (!module) {
    return null;
  }

  try {
    const identifier = await module.begin(name);
    return Number.isFinite(identifier) && identifier > 0 ? identifier : null;
  } catch {
    return null;
  }
}

export async function endBackgroundExecutionAssertionAsync(identifier: number | null) {
  if (identifier === null) {
    return;
  }

  await getNativeModule()?.end(identifier).catch(() => {});
}

export async function withBackgroundExecutionAssertionAsync<T>(
  name: string,
  task: () => Promise<T>,
) {
  const identifier = await beginBackgroundExecutionAssertionAsync(name);

  try {
    return await task();
  } finally {
    await endBackgroundExecutionAssertionAsync(identifier);
  }
}
