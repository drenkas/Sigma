export const PINNED_BINARY_NAME:string;
export const PINNED_BINARY_SHA256:string;
export function readDeployment(dataDir:string,options?:{sha256?:string}):{binary:string;directory:string;auth:string;configPath:string;baseUrl:string;apiKey:string};
export function proxyEnvironment():Record<string,string>;
