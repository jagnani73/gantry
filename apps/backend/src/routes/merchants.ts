import { Router } from "express";
import { getMerchant } from "../services/merchants";

export const merchantsRouter = Router();

merchantsRouter.get("/api/merchants/:handle", async (req, res) => {
  res.json(await getMerchant(req.params.handle));
});
