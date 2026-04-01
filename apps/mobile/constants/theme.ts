import { DarkTheme, type Theme } from '@react-navigation/native';

export const colors = {
  background: '#040913',
  backgroundTop: '#0a1020',
  backgroundBottom: '#050913',
  surface: 'rgba(12, 19, 31, 0.92)',
  surfaceStrong: 'rgba(15, 24, 38, 0.98)',
  surfaceMuted: 'rgba(13, 19, 31, 0.72)',
  border: 'rgba(152, 181, 255, 0.14)',
  borderStrong: 'rgba(152, 181, 255, 0.22)',
  text: '#f6f8ff',
  muted: '#94a0b7',
  subtle: '#6d7890',
  primary: '#72ff6b',
  primaryBright: '#e5ff67',
  cyan: '#56f6ff',
  aqua: '#56f6cf',
  violet: '#8564ff',
  indigo: '#6250ff',
  heart: '#ffb15d',
  alert: '#ff7d70',
  success: '#7effa9',
  tabInactive: '#77819a',
  white: '#ffffff',
  black: '#000000',
};

export const sleepStageColors = {
  awake: colors.alert,
  rem: colors.violet,
  deep: colors.indigo,
  light: colors.aqua,
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
