// Optional integration protocol. Standalone operation never needs a parent.
export function embeddingOrigin(search){
  const params=new URLSearchParams(search);if(params.get("embedded")!=="1")return;
  try{const url=new URL(params.get("parentOrigin"));if(["http:","https:"].includes(url.protocol)&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))return url.origin;}catch{}
}
