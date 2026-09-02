import { Router, type IRouter } from "express";
import healthRouter from "./health";
import llamaRouter from "./llama";

const router: IRouter = Router();

router.use(healthRouter);
router.use(llamaRouter);

export default router;
