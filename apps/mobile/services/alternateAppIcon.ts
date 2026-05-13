import DynamicAppIcon from 'react-native-dynamic-app-icon';
import { Platform } from 'react-native';

export type AlternateAppIconName = 'WindDown' | null;

const PRIMARY_ICON_NAME = 'default';

export async function supportsAlternateIconsAsync() {
  if (Platform.OS !== 'ios') {
    return false;
  }

  try {
    return await DynamicAppIcon.supportsDynamicAppIcon();
  } catch {
    return false;
  }
}

async function getCurrentIconNameAsync() {
  return await new Promise<string>((resolve) => {
    try {
      DynamicAppIcon.getIconName(({ iconName }) => {
        resolve(iconName);
      });
    } catch {
      resolve(PRIMARY_ICON_NAME);
    }
  });
}

export async function getAlternateIconNameAsync(): Promise<AlternateAppIconName> {
  if (!(await supportsAlternateIconsAsync())) {
    return null;
  }

  const iconName = await getCurrentIconNameAsync();
  return iconName === 'WindDown' ? iconName : null;
}

export async function setAlternateIconNameAsync(name: AlternateAppIconName) {
  if (!(await supportsAlternateIconsAsync())) {
    return;
  }

  DynamicAppIcon.setAppIcon(name);
}
