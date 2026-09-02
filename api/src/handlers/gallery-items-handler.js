const { parseGalleryItemsRequest } = require("../http/request");
const { errorResponse, galleryItemsResponse } = require("../http/responses");

function createGalleryItemsHandler({ service }) {
  if (typeof service?.getItems !== "function") {
    throw new TypeError("service.getItems must be a function.");
  }
  return async function galleryItemsHandler(request, context) {
    try {
      const input = parseGalleryItemsRequest(request);
      return galleryItemsResponse(await service.getItems(input));
    } catch (error) {
      return errorResponse(error, context);
    }
  };
}

module.exports = { createGalleryItemsHandler };