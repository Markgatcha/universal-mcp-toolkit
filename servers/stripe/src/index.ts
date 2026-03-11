import { pathToFileURL } from "node:url";

import {
  HttpServiceClient,
  ToolkitServer,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const TOOL_NAMES = ["list-customers", "get-invoice", "list-subscriptions"] as const;
const RESOURCE_NAMES = ["account"] as const;
const PROMPT_NAMES = ["billing-audit"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "stripe",
  title: "Stripe MCP Server",
  description: "Customer, invoice, subscription, and billing-audit tools for Stripe.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-stripe",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["STRIPE_SECRET_KEY"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

const nonEmptyString = z.string().trim().min(1);
const metadataSchema = z.record(z.string(), z.string());

const stripeEnvShape = {
  STRIPE_SECRET_KEY: nonEmptyString,
  STRIPE_API_BASE_URL: z.string().url().default("https://api.stripe.com"),
} satisfies z.ZodRawShape;

type StripeEnv = z.infer<z.ZodObject<typeof stripeEnvShape>>;

export interface StripeConfig {
  secretKey: string;
  baseUrl: string;
}

const stripeCustomerShape = {
  id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  created: z.number().int().nonnegative(),
  delinquent: z.boolean(),
  currency: z.string().nullable(),
  balance: z.number().int(),
  livemode: z.boolean(),
  metadata: metadataSchema,
} satisfies z.ZodRawShape;

const stripeCustomerSchema = z.object(stripeCustomerShape);
export type StripeCustomer = z.infer<typeof stripeCustomerSchema>;

const stripeInvoiceLineShape = {
  description: z.string().nullable(),
  quantity: z.number().int().nullable(),
  amount: z.number().int(),
  currency: z.string(),
  priceId: z.string().nullable(),
  productId: z.string().nullable(),
  recurringInterval: z.string().nullable(),
  recurringIntervalCount: z.number().int().nullable(),
} satisfies z.ZodRawShape;

const stripeInvoiceLineSchema = z.object(stripeInvoiceLineShape);
export type StripeInvoiceLine = z.infer<typeof stripeInvoiceLineSchema>;

const stripeInvoiceShape = {
  id: z.string(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  currency: z.string(),
  subtotal: z.number().int(),
  total: z.number().int(),
  amountDue: z.number().int(),
  amountPaid: z.number().int(),
  created: z.number().int().nonnegative(),
  dueDate: z.number().int().nullable(),
  customerId: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
  invoicePdf: z.string().nullable(),
  lineItems: z.array(z.object(stripeInvoiceLineShape)),
} satisfies z.ZodRawShape;

const stripeInvoiceSchema = z.object(stripeInvoiceShape);
export type StripeInvoice = z.infer<typeof stripeInvoiceSchema>;

const stripeSubscriptionItemShape = {
  priceId: z.string().nullable(),
  nickname: z.string().nullable(),
  productId: z.string().nullable(),
  currency: z.string().nullable(),
  unitAmount: z.number().int().nullable(),
  recurringInterval: z.string().nullable(),
  recurringIntervalCount: z.number().int().nullable(),
  quantity: z.number().int().nullable(),
} satisfies z.ZodRawShape;

const stripeSubscriptionItemSchema = z.object(stripeSubscriptionItemShape);
export type StripeSubscriptionItem = z.infer<typeof stripeSubscriptionItemSchema>;

const stripeSubscriptionShape = {
  id: z.string(),
  status: z.string(),
  customerId: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.number().int().nullable(),
  currentPeriodEnd: z.number().int().nullable(),
  items: z.array(z.object(stripeSubscriptionItemShape)),
} satisfies z.ZodRawShape;

const stripeSubscriptionSchema = z.object(stripeSubscriptionShape);
export type StripeSubscription = z.infer<typeof stripeSubscriptionSchema>;

const listCustomersOutputShape = {
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  customers: z.array(z.object(stripeCustomerShape)),
} satisfies z.ZodRawShape;

const listCustomersOutputSchema = z.object(listCustomersOutputShape);
export type StripeListCustomersOutput = z.infer<typeof listCustomersOutputSchema>;

const getInvoiceOutputShape = {
  invoice: z.object(stripeInvoiceShape),
} satisfies z.ZodRawShape;

const getInvoiceOutputSchema = z.object(getInvoiceOutputShape);
export type StripeGetInvoiceOutput = z.infer<typeof getInvoiceOutputSchema>;

const listSubscriptionsOutputShape = {
  customerId: z.string().nullable(),
  statusFilter: z.string().nullable(),
  hasMore: z.boolean(),
  subscriptions: z.array(z.object(stripeSubscriptionShape)),
} satisfies z.ZodRawShape;

const listSubscriptionsOutputSchema = z.object(listSubscriptionsOutputShape);
export type StripeListSubscriptionsOutput = z.infer<typeof listSubscriptionsOutputSchema>;

interface StripeAccountOverview {
  generatedAt: string;
  account: {
    id: string;
    email: string | null;
    country: string | null;
    defaultCurrency: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    businessName: string | null;
    supportEmail: string | null;
    supportUrl: string | null;
  };
}

export interface StripeClient {
  listCustomers(input: { limit: number; email?: string }): Promise<StripeListCustomersOutput>;
  getCustomer(customerId: string): Promise<StripeCustomer>;
  getInvoice(invoiceId: string): Promise<StripeGetInvoiceOutput>;
  listSubscriptions(input: {
    limit: number;
    customerId?: string;
    status: "active" | "all" | "canceled" | "ended" | "incomplete" | "incomplete_expired" | "past_due" | "paused" | "trialing" | "unpaid";
  }): Promise<StripeListSubscriptionsOutput>;
  listInvoices(input: { customerId: string; limit: number }): Promise<StripeInvoice[]>;
  getAccount(): Promise<StripeAccountOverview>;
}

const expandableIdSchema = z.union([
  z.string(),
  z
    .object({
      id: z.string(),
    })
    .passthrough(),
  z.null(),
]);

function extractExpandableId(value: z.infer<typeof expandableIdSchema> | undefined): string | null {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? value : value.id;
}

const rawCustomerSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    created: z.number().int().nonnegative(),
    delinquent: z.boolean().optional(),
    currency: z.string().nullable().optional(),
    balance: z.number().int().optional(),
    livemode: z.boolean().optional(),
    metadata: metadataSchema.optional(),
  })
  .passthrough();

type RawCustomer = z.infer<typeof rawCustomerSchema>;

const rawCustomerListResponseSchema = z
  .object({
    has_more: z.boolean().optional(),
    data: z.array(rawCustomerSchema).optional().default([]),
  })
  .passthrough();

const rawRecurringSchema = z
  .object({
    interval: z.string().nullable().optional(),
    interval_count: z.number().int().nullable().optional(),
  })
  .passthrough();

const rawPriceSchema = z
  .object({
    id: z.string().nullable().optional(),
    nickname: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    unit_amount: z.number().int().nullable().optional(),
    recurring: rawRecurringSchema.nullable().optional(),
    product: expandableIdSchema.optional(),
  })
  .passthrough();

type RawPrice = z.infer<typeof rawPriceSchema>;

const rawInvoiceLineSchema = z
  .object({
    description: z.string().nullable().optional(),
    quantity: z.number().int().nullable().optional(),
    amount: z.number().int(),
    currency: z.string(),
    price: rawPriceSchema.nullable().optional(),
  })
  .passthrough();

type RawInvoiceLine = z.infer<typeof rawInvoiceLineSchema>;

const rawInvoiceSchema = z
  .object({
    id: z.string(),
    number: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    currency: z.string(),
    subtotal: z.number().int().optional(),
    total: z.number().int().optional(),
    amount_due: z.number().int().optional(),
    amount_paid: z.number().int().optional(),
    created: z.number().int().nonnegative(),
    due_date: z.number().int().nullable().optional(),
    customer: expandableIdSchema.optional(),
    hosted_invoice_url: z.string().nullable().optional(),
    invoice_pdf: z.string().nullable().optional(),
    lines: z
      .object({
        data: z.array(rawInvoiceLineSchema).optional().default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type RawInvoice = z.infer<typeof rawInvoiceSchema>;

const rawInvoiceListResponseSchema = z
  .object({
    data: z.array(rawInvoiceSchema).optional().default([]),
  })
  .passthrough();

const rawSubscriptionItemSchema = z
  .object({
    quantity: z.number().int().nullable().optional(),
    price: rawPriceSchema.nullable().optional(),
  })
  .passthrough();

type RawSubscriptionItem = z.infer<typeof rawSubscriptionItemSchema>;

const rawSubscriptionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    customer: expandableIdSchema.optional(),
    cancel_at_period_end: z.boolean().optional(),
    current_period_start: z.number().int().nullable().optional(),
    current_period_end: z.number().int().nullable().optional(),
    items: z
      .object({
        data: z.array(rawSubscriptionItemSchema).optional().default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type RawSubscription = z.infer<typeof rawSubscriptionSchema>;

const rawSubscriptionListResponseSchema = z
  .object({
    has_more: z.boolean().optional(),
    data: z.array(rawSubscriptionSchema).optional().default([]),
  })
  .passthrough();

const rawAccountSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    default_currency: z.string().nullable().optional(),
    charges_enabled: z.boolean().optional(),
    payouts_enabled: z.boolean().optional(),
    details_submitted: z.boolean().optional(),
    business_profile: z
      .object({
        name: z.string().nullable().optional(),
        support_email: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function toStripeConfig(env: StripeEnv): StripeConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    baseUrl: env.STRIPE_API_BASE_URL,
  };
}

function loadStripeConfig(source: NodeJS.ProcessEnv = process.env): StripeConfig {
  return toStripeConfig(loadEnv(stripeEnvShape, source));
}

function mapCustomer(raw: RawCustomer): StripeCustomer {
  return {
    id: raw.id,
    email: raw.email ?? null,
    name: raw.name ?? null,
    description: raw.description ?? null,
    created: raw.created,
    delinquent: raw.delinquent ?? false,
    currency: raw.currency ?? null,
    balance: raw.balance ?? 0,
    livemode: raw.livemode ?? false,
    metadata: raw.metadata ?? {},
  };
}

function mapInvoiceLine(raw: RawInvoiceLine): StripeInvoiceLine {
  return {
    description: raw.description ?? null,
    quantity: raw.quantity ?? null,
    amount: raw.amount,
    currency: raw.currency,
    priceId: raw.price?.id ?? null,
    productId: extractExpandableId(raw.price?.product),
    recurringInterval: raw.price?.recurring?.interval ?? null,
    recurringIntervalCount: raw.price?.recurring?.interval_count ?? null,
  };
}

function mapInvoice(raw: RawInvoice): StripeInvoice {
  return {
    id: raw.id,
    number: raw.number ?? null,
    status: raw.status ?? null,
    currency: raw.currency,
    subtotal: raw.subtotal ?? 0,
    total: raw.total ?? 0,
    amountDue: raw.amount_due ?? 0,
    amountPaid: raw.amount_paid ?? 0,
    created: raw.created,
    dueDate: raw.due_date ?? null,
    customerId: extractExpandableId(raw.customer),
    hostedInvoiceUrl: raw.hosted_invoice_url ?? null,
    invoicePdf: raw.invoice_pdf ?? null,
    lineItems: (raw.lines?.data ?? []).map(mapInvoiceLine),
  };
}

function mapSubscriptionItem(raw: RawSubscriptionItem): StripeSubscriptionItem {
  return {
    priceId: raw.price?.id ?? null,
    nickname: raw.price?.nickname ?? null,
    productId: extractExpandableId(raw.price?.product),
    currency: raw.price?.currency ?? null,
    unitAmount: raw.price?.unit_amount ?? null,
    recurringInterval: raw.price?.recurring?.interval ?? null,
    recurringIntervalCount: raw.price?.recurring?.interval_count ?? null,
    quantity: raw.quantity ?? null,
  };
}

function mapSubscription(raw: RawSubscription): StripeSubscription {
  return {
    id: raw.id,
    status: raw.status,
    customerId: extractExpandableId(raw.customer),
    cancelAtPeriodEnd: raw.cancel_at_period_end ?? false,
    currentPeriodStart: raw.current_period_start ?? null,
    currentPeriodEnd: raw.current_period_end ?? null,
    items: (raw.items?.data ?? []).map(mapSubscriptionItem),
  };
}

function renderCustomers(output: StripeListCustomersOutput): string {
  if (output.customers.length === 0) {
    return "No customers found.";
  }

  return output.customers
    .map((customer: StripeCustomer) => `- ${customer.name ?? customer.email ?? customer.id} (${customer.id})`)
    .join("\n");
}

function renderInvoice(output: StripeGetInvoiceOutput): string {
  return `Invoice ${output.invoice.number ?? output.invoice.id} | ${output.invoice.status ?? "unknown"} | ${output.invoice.total} ${output.invoice.currency.toUpperCase()}`;
}

function renderSubscriptions(output: StripeListSubscriptionsOutput): string {
  if (output.subscriptions.length === 0) {
    return "No subscriptions found.";
  }

  return output.subscriptions.map((subscription: StripeSubscription) => `- ${subscription.id} (${subscription.status})`).join("\n");
}

class StripeHttpClient extends HttpServiceClient implements StripeClient {
  public constructor(config: StripeConfig, logger: ToolkitServer["logger"]) {
    super({
      serviceName: "stripe",
      baseUrl: config.baseUrl,
      logger,
      defaultHeaders: () => ({
        authorization: `Bearer ${config.secretKey}`,
        accept: "application/json",
      }),
    });
  }

  public async listCustomers(input: { limit: number; email?: string }): Promise<StripeListCustomersOutput> {
    const response = await this.getJson<z.infer<typeof rawCustomerListResponseSchema>>("/v1/customers", rawCustomerListResponseSchema, {
      query: {
        limit: input.limit,
        email: input.email,
      },
    });

    return {
      limit: input.limit,
      hasMore: response.has_more ?? false,
      customers: response.data.map(mapCustomer),
    };
  }

  public async getCustomer(customerId: string): Promise<StripeCustomer> {
    const response = await this.getJson<z.infer<typeof rawCustomerSchema>>(
      `/v1/customers/${encodeURIComponent(customerId)}`,
      rawCustomerSchema,
    );
    return mapCustomer(response);
  }

  public async getInvoice(invoiceId: string): Promise<StripeGetInvoiceOutput> {
    const response = await this.getJson<z.infer<typeof rawInvoiceSchema>>(
      `/v1/invoices/${encodeURIComponent(invoiceId)}`,
      rawInvoiceSchema,
    );
    return {
      invoice: mapInvoice(response),
    };
  }

  public async listSubscriptions(input: {
    limit: number;
    customerId?: string;
    status: "active" | "all" | "canceled" | "ended" | "incomplete" | "incomplete_expired" | "past_due" | "paused" | "trialing" | "unpaid";
  }): Promise<StripeListSubscriptionsOutput> {
    const response = await this.getJson<z.infer<typeof rawSubscriptionListResponseSchema>>(
      "/v1/subscriptions",
      rawSubscriptionListResponseSchema,
      {
        query: {
          limit: input.limit,
          customer: input.customerId,
          status: input.status,
        },
      },
    );

    return {
      customerId: input.customerId ?? null,
      statusFilter: input.status,
      hasMore: response.has_more ?? false,
      subscriptions: response.data.map(mapSubscription),
    };
  }

  public async listInvoices(input: { customerId: string; limit: number }): Promise<StripeInvoice[]> {
    const response = await this.getJson<z.infer<typeof rawInvoiceListResponseSchema>>("/v1/invoices", rawInvoiceListResponseSchema, {
      query: {
        customer: input.customerId,
        limit: input.limit,
      },
    });

    return response.data.map(mapInvoice);
  }

  public async getAccount(): Promise<StripeAccountOverview> {
    const response = await this.getJson<z.infer<typeof rawAccountSchema>>("/v1/account", rawAccountSchema);
    return {
      generatedAt: new Date().toISOString(),
      account: {
        id: response.id,
        email: response.email ?? null,
        country: response.country ?? null,
        defaultCurrency: response.default_currency ?? null,
        chargesEnabled: response.charges_enabled ?? false,
        payoutsEnabled: response.payouts_enabled ?? false,
        detailsSubmitted: response.details_submitted ?? false,
        businessName: response.business_profile?.name ?? null,
        supportEmail: response.business_profile?.support_email ?? null,
        supportUrl: response.business_profile?.url ?? null,
      },
    };
  }
}

export interface StripeServerOptions {
  config?: StripeConfig;
  client?: StripeClient;
  env?: NodeJS.ProcessEnv;
}

export class StripeServer extends ToolkitServer {
  private readonly client: StripeClient;

  public constructor(options: { config: StripeConfig; client?: StripeClient }) {
    super(metadata);

    this.client = options.client ?? new StripeHttpClient(options.config, this.logger);

    this.registerTool(
      defineTool({
        name: "list-customers",
        title: "List customers",
        description: "List Stripe customers, optionally filtered by email address.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          limit: z.number().int().positive().max(100).default(10),
          email: z.string().trim().email().optional(),
        },
        outputSchema: listCustomersOutputShape,
        handler: async ({ limit, email }) => {
          const request = {
            limit,
            ...(email ? { email } : {}),
          };

          return this.client.listCustomers(request);
        },
        renderText: renderCustomers,
      }),
    );

    this.registerTool(
      defineTool({
        name: "get-invoice",
        title: "Get invoice",
        description: "Fetch a Stripe invoice with line-item details and billing links.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          invoiceId: nonEmptyString,
        },
        outputSchema: getInvoiceOutputShape,
        handler: async ({ invoiceId }) => this.client.getInvoice(invoiceId),
        renderText: renderInvoice,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list-subscriptions",
        title: "List subscriptions",
        description: "List Stripe subscriptions, optionally for a single customer.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          customerId: nonEmptyString.optional(),
          limit: z.number().int().positive().max(100).default(10),
          status: z
            .enum(["active", "all", "canceled", "ended", "incomplete", "incomplete_expired", "past_due", "paused", "trialing", "unpaid"])
            .default("all"),
        },
        outputSchema: listSubscriptionsOutputShape,
        handler: async ({ customerId, limit, status }) => {
          const request = {
            limit,
            status,
            ...(customerId ? { customerId } : {}),
          };

          return this.client.listSubscriptions(request);
        },
        renderText: renderSubscriptions,
      }),
    );

    this.registerStaticResource(
      "account",
      "stripe://account",
      {
        title: "Stripe Account",
        description: "A JSON snapshot of the configured Stripe account and payout settings.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.client.getAccount()),
    );

    this.registerPrompt(
      "billing-audit",
      {
        title: "Billing Audit",
        description: "Generate a billing-audit prompt for a Stripe customer using subscriptions and recent invoices.",
        argsSchema: {
          customerId: nonEmptyString,
          recentInvoiceLimit: z.number().int().positive().max(10).default(3),
          focus: nonEmptyString.optional(),
        },
      },
      async ({ customerId, recentInvoiceLimit, focus }) => {
        const promptInput = {
          customerId,
          recentInvoiceLimit,
          ...(focus ? { focus } : {}),
        };

        return this.createTextPrompt(await this.buildBillingAuditPrompt(promptInput));
      },
    );
  }

  private async buildBillingAuditPrompt(input: {
    customerId: string;
    recentInvoiceLimit: number;
    focus?: string;
  }): Promise<string> {
    const [customer, subscriptions, invoices] = await Promise.all([
      this.client.getCustomer(input.customerId),
      this.client.listSubscriptions({
        customerId: input.customerId,
        limit: 20,
        status: "all",
      }),
      this.client.listInvoices({
        customerId: input.customerId,
        limit: input.recentInvoiceLimit,
      }),
    ]);

    const subscriptionLines =
      subscriptions.subscriptions.length === 0
        ? ["- No subscriptions found."]
        : subscriptions.subscriptions.map((subscription: StripeSubscription) => {
            const itemSummary =
              subscription.items.length === 0
                ? "no line items"
                : subscription.items
                    .map((item: StripeSubscriptionItem) => `${item.priceId ?? "unknown-price"} (${item.unitAmount ?? 0} ${item.currency ?? "usd"})`)
                    .join(", ");
            return `- ${subscription.id} | ${subscription.status} | ${itemSummary}`;
          });

    const invoiceLines =
      invoices.length === 0
        ? ["- No recent invoices found."]
        : invoices.map(
            (invoice: StripeInvoice) =>
              `- ${invoice.number ?? invoice.id} | ${invoice.status ?? "unknown"} | ${invoice.total} ${invoice.currency.toUpperCase()} | due ${invoice.dueDate ?? "n/a"}`,
          );

    return [
      "Audit this Stripe customer's billing setup.",
      `Customer: ${customer.name ?? customer.email ?? customer.id} (${customer.id})`,
      `Email: ${customer.email ?? "unknown"}`,
      `Delinquent: ${customer.delinquent ? "yes" : "no"}`,
      focus ? `Focus: ${focus}` : "Focus: correctness, renewal risk, and opportunities to simplify billing.",
      "",
      "Subscriptions:",
      ...subscriptionLines,
      "",
      "Recent invoices:",
      ...invoiceLines,
      "",
      "Please provide:",
      "1. Billing health summary.",
      "2. Risks, anomalies, or confusing charges.",
      "3. Specific follow-up actions for finance or customer success.",
    ].join("\n");
  }
}

export function createServer(options: StripeServerOptions = {}): StripeServer {
  const config = options.config ?? loadStripeConfig(options.env);

  return options.client
    ? new StripeServer({
        config,
        client: options.client,
      })
    : new StripeServer({
        config,
      });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtimeOptions = parseRuntimeOptions(argv);
  await runToolkitServer(
    {
      createServer: () => createServer(),
      serverCard,
    },
    runtimeOptions,
  );
}

function isMainModule(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return typeof entryPoint === "string" && pathToFileURL(entryPoint).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  void main();
}
