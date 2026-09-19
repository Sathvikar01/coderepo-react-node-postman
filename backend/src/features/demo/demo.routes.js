import { Router } from "express";
import {
	createOrder,
	datasetTokens,
	deleteOrder,
	echo,
	formatSamples,
	getOrder,
	gzip,
	listOrders,
	slow,
	statusCode,
	updateOrder,
} from "./demo.controller.js";

export const demoRouter = Router();
demoRouter.get("/v1/tokens", datasetTokens);
demoRouter.get("/v1/echo", echo);
demoRouter.get("/v1/status/:code", statusCode);
demoRouter.get("/v1/slow", slow);
demoRouter.get("/v1/gzip", gzip);
demoRouter.get("/v1/samples/:kind", formatSamples);
demoRouter.get("/v1/:dataset/orders", listOrders);
demoRouter.post("/v1/:dataset/orders", createOrder);
demoRouter.get("/v1/:dataset/orders/:orderId", getOrder);
demoRouter.patch("/v1/:dataset/orders/:orderId", updateOrder);
demoRouter.delete("/v1/:dataset/orders/:orderId", deleteOrder);
