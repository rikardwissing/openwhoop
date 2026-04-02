import { DarkTheme, type Theme } from '@react-navigation/native';

export const colors = {
  background: '#02060d',
  backgroundTop: '#06111a',
  backgroundBottom: '#01050b',
  surface: 'rgba(8, 18, 25, 0.92)',
  surfaceStrong: 'rgba(10, 22, 30, 0.98)',
  surfaceMuted: 'rgba(7, 17, 24, 0.78)',
  border: 'rgba(89, 245, 255, 0.14)',
  borderStrong: 'rgba(162, 255, 110, 0.24)',
  text: '#f7fbff',
  muted: '#98adb8',
  subtle: '#708490',
  primary: '#68ff78',
  primaryBright: '#ecff72',
  cyan: '#59f5ff',
  aqua: '#56ffd1',
  violet: '#c8ff63',
  indigo: '#2bd8b8',
  heart: '#ffd26b',
  alert: '#ff7d70',
  success: '#8dffb3',
  tabInactive: '#728594',
  white: '#ffffff',
  black: '#000000',
};

export const sleepStageColors = {
  awake: colors.alert,
  rem: colors.primaryBright,
  deep: colors.aqua,
  light: colors.cyan,
};

export const typography = {
  heading: 'SpaceGroteskBold',
  headingMedium: 'SpaceGroteskMedium',
  body: 'ManropeMedium',
  bodySemiBold: 'ManropeSemiBold',
  bodyBold: 'ManropeBold',
};

export const spacing = {
  screenPadding: 20,
  sectionGap: 18,
  cardPadding: 16,
};

export const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.surfaceStrong,
    text: colors.text,
    border: colors.border,
    notification: colors.alert,
  },
};
