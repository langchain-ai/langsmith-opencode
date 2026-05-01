import { vi } from "vitest";
import { Client } from "langsmith";

type ClientParams = Exclude<ConstructorParameters<typeof Client>[0], undefined>;
export const mockClient = (config?: Omit<ClientParams, "autoBatchTracing">) => {
  const mockFetch = vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as Response);

  const client = new Client({
    ...config,
    apiKey: "MOCK",
    autoBatchTracing: false,
    fetchImplementation: mockFetch,
  });

  const callSpy = mockFetch;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client, callSpy: callSpy as any };
};
