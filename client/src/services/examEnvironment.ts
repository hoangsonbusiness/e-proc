export interface ExamEnvironmentSnapshot {
  platform: string;
  screenCheckSupported: boolean;
  screenExtended: boolean | null;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  ramGiB: number | null;
  logicalCpuCores: number | null;
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    platform?: string;
  };
}

interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number;
}

export function getExamEnvironmentSnapshot(): ExamEnvironmentSnapshot {
  const screenWithExtended = window.screen as Screen & { isExtended?: boolean };
  const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
  const navigatorWithDeviceMemory = navigator as NavigatorWithDeviceMemory;
  const screenCheckSupported = typeof screenWithExtended.isExtended === 'boolean';
  const deviceMemory = navigatorWithDeviceMemory.deviceMemory;
  const hardwareConcurrency = navigator.hardwareConcurrency;

  return {
    platform: navigatorWithUserAgentData.userAgentData?.platform || navigator.platform || 'unknown',
    screenCheckSupported,
    screenExtended: screenCheckSupported ? Boolean(screenWithExtended.isExtended) : null,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    devicePixelRatio: window.devicePixelRatio || 1,
    ramGiB: typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) ? deviceMemory : null,
    logicalCpuCores: typeof hardwareConcurrency === 'number' && Number.isFinite(hardwareConcurrency)
      ? hardwareConcurrency
      : null,
  };
}
