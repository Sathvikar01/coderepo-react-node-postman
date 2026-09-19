import mongoose from "mongoose";

const demoOrderSchema = new mongoose.Schema(
    {
        dataset: { type: String, enum: ["local", "staging"], required: true },
        id: { type: String, required: true },
        customer: { type: String, required: true, maxlength: 120 },
        items: [{ name: { type: String, required: true, maxlength: 120 }, quantity: { type: Number, required: true, min: 1 }, unitCents: { type: Number, required: true, min: 0 } }],
        totalCents: { type: Number, required: true, min: 0 },
        status: { type: String, enum: ["pending", "paid", "shipped", "cancelled"], required: true, default: "pending" },
    },
    { timestamps: true, versionKey: false },
);

demoOrderSchema.index({ dataset: 1, id: 1 }, { unique: true });

export const DemoOrder = mongoose.model("DemoOrder", demoOrderSchema);
