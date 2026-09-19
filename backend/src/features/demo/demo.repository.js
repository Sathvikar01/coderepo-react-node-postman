import { DemoOrder } from "./demo-order.model.js";

export const demoRepository = {
    list: (dataset, { status, limit } = {}) => {
        const query = DemoOrder.find({ dataset, ...(status ? { status } : {}) }).sort({ id: 1 }).lean();
        return limit ? query.limit(limit) : query;
    },
    findById: (dataset, id) => DemoOrder.findOne({ dataset, id }).lean(),
    create: (input) => DemoOrder.create(input),
    update: (dataset, id, input) => DemoOrder.findOneAndUpdate({ dataset, id }, { $set: input }, { new: true, runValidators: true }).lean(),
    remove: (dataset, id) => DemoOrder.findOneAndDelete({ dataset, id }).lean(),
    deleteAll: () => DemoOrder.deleteMany({}),
    insertMany: (items) => DemoOrder.insertMany(items),
};
