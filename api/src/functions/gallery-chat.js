const { app } = require("@azure/functions");

const { createGalleryChatHandler } = require("../handlers/gallery-chat-handler");
const { getRuntimeServices } = require("../runtime/services");

app.http("galleryChat", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "gallery/chat",
  handler: async (request, context) => {
    const { chatService, rateLimiter, config } = getRuntimeServices();
    return createGalleryChatHandler({
      service: chatService,
      rateLimiter,
      expectedPrincipalId: config.apimPrincipalId,
    })(request, context);
  },
});