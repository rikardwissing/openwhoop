export function resolveScanDeviceName(device: {
  name?: string | null;
  localName?: string | null;
}) {
  return device.localName ?? device.name ?? 'Unnamed wearable';
}
