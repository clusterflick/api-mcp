import { handleRequest } from "./handler";

// The entry module exports only the Worker: workerd refuses anything else.
export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
