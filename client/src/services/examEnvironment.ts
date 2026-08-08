export interface ExamEnvironmentSnapshot {
  platform: string;
  screenCheckSupported: boolean;
  screenExtended: boolean | null;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    platform?: string;
  };
}

export function getExamEnvironmentSnapshot(): ExamEnvironmentSnapshot {
  const screenWithExtended = window.screen as Screen & { isExtended?: boolean };
  const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
  const screenCheckSupported = typeof screenWithExtended.isExtended === 'boolean';

  return {
    platform: navigatorWithUserAgentData.userAgentData?.platform || navigator.platform || 'unknown',
    screenCheckSupported,
    screenExtended: screenCheckSupported ? Boolean(screenWithExtended.isExtended) : null,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}
