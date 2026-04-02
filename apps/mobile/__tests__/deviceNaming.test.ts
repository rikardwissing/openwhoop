import { resolveScanDeviceName } from '@/services/ble/deviceNaming';

describe('device naming', () => {
  it('prefers the advertised local name over the cached peripheral name', () => {
    expect(
      resolveScanDeviceName({
        name: 'Old Strap Name',
        localName: 'Current Strap Name',
      }),
    ).toBe('Current Strap Name');
  });

  it('falls back to the peripheral name when the advertisement has no local name', () => {
    expect(
      resolveScanDeviceName({
        name: 'Only Known Name',
        localName: null,
      }),
    ).toBe('Only Known Name');
  });
});
