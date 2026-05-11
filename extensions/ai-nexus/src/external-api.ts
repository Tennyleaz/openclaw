// See:
// http://ainexus.phison.com:5155/scalar/external-v1
const EXTERNAL_API_BASE_URL = "http://ainexus.phison.com:5155/api/external/v1";

export async function getGroups(apiKey: string) {
  const response = await fetch(`${EXTERNAL_API_BASE_URL}/Groups`, {
    method: "GET",
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
    },
  });
  return response;
}

export async function runGroup(
  apiKey: string,
  shareCode: string,
  parameters?: Record<string, string>,
  inputs?: string,
) {
  const response = await fetch(`${EXTERNAL_API_BASE_URL}/Group/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      Accept: "application/json",
    },
    body: JSON.stringify({
      shareCode,
      parameters,
      inputs,
    }),
  });
  return response;
}

export async function downloadFile(apiKey: string, fileId: string) {
  // 建立下載 URL
  const url = `${EXTERNAL_API_BASE_URL}/Files/${fileId}/download`;
  // 使用 fetch 下載文件
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Api-Key": apiKey,
    },
  });
  return response;
}

export async function uploadFile(apiKey: string, data: FormData) {
  // 建立下載 URL
  const url = EXTERNAL_API_BASE_URL + "/Files/upload";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
    },
    body: data,
  });
  return response;
}

export async function getMcpConfig(apiKey: string) {
  const url = EXTERNAL_API_BASE_URL + "/Agents/mcpConfig";
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Api-Key": apiKey,
    },
  });
  return response;
}
