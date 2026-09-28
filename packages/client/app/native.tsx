import { NativeApp } from "../src/native/NativeApp";

/**
 * The phone app in a browser (decision 0013, ruling 6): `NativeApp` rendered through react-native-web,
 * for testing the phone's flow without a device. On native it is simply the app.
 */
export default function Native() {
  return <NativeApp />;
}
