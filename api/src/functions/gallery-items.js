const { app } = require("@azure/functions");

const { createGalleryItemsHandler } = require("../handlers/gallery-items-handler");
const { getRuntimeServices } = require("../runtime/services");

app.http("galleryItems", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "gallery/items",
  handler: async (request, context) => {
    const { itemsService } = getRuntimeServices();
    return createGalleryItemsHandler({ service: itemsService })(request, context);
  },
});