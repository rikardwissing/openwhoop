declare module 'react-native-dynamic-app-icon' {
  export interface DynamicAppIconResult {
    iconName: string;
  }

  export interface DynamicAppIconModule {
    setAppIcon(name: string | null): void;
    supportsDynamicAppIcon(): Promise<boolean>;
    getIconName(callback: (result: DynamicAppIconResult) => void): void;
  }

  const DynamicAppIcon: DynamicAppIconModule;
  export default DynamicAppIcon;
}