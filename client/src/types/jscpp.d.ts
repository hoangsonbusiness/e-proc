// JSCPP không có type definitions chính thức
declare module 'JSCPP' {
  interface JSCPPConfig {
    stdio?: {
      write?: (s: string) => void;
    };
    [key: string]: unknown;
  }
  const JSCPP: {
    run(code: string, input: string, config?: JSCPPConfig): number;
  };
  export default JSCPP;
}
