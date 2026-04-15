require('react-native-gesture-handler/jestSetup');
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
require('react-native-reanimated').setUpTests();
jest.mock('@shopify/react-native-skia', () => {
	jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
		const Noop = () => undefined;

		return {
			OS: 'web',
			PixelRatio: 1,
			requireNativeComponent: Noop,
			resolveAsset: Noop,
			findNodeHandle: Noop,
			NativeModules: Noop,
			View: Noop,
		};
	});

	jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({
		useFont: () => null,
		matchFont: () => null,
		listFontFamilies: () => [],
		useFonts: () => null,
	}));

	return require('@shopify/react-native-skia/lib/commonjs/mock').Mock(global.CanvasKit);
});