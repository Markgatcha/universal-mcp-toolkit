import { describe, expect, it } from "vitest";

import {
  StripeServer,
  createServer,
  serverCard,
  type StripeClient,
  type StripeConfig,
} from "../src/index.js";

const config: StripeConfig = {
  secretKey: "sk_test_123",
  baseUrl: "https://stripe.example.test",
};

const fakeClient: StripeClient = {
  async listCustomers(input) {
    return {
      limit: input.limit,
      hasMore: false,
      customers: [
        {
          id: "cus_123",
          email: "buyer@example.com",
          name: "Buyer",
          description: "Enterprise account",
          created: 1710000000,
          delinquent: false,
          currency: "usd",
          balance: 0,
          livemode: false,
          metadata: {
            segment: "enterprise",
          },
        },
      ],
    };
  },
  async getCustomer(customerId) {
    return {
      id: customerId,
      email: "buyer@example.com",
      name: "Buyer",
      description: "Enterprise account",
      created: 1710000000,
      delinquent: false,
      currency: "usd",
      balance: 0,
      livemode: false,
      metadata: {
        segment: "enterprise",
      },
    };
  },
  async getInvoice(invoiceId) {
    return {
      invoice: {
        id: invoiceId,
        number: "INV-001",
        status: "paid",
        currency: "usd",
        subtotal: 12000,
        total: 12000,
        amountDue: 0,
        amountPaid: 12000,
        created: 1710003600,
        dueDate: null,
        customerId: "cus_123",
        hostedInvoiceUrl: "https://stripe.example.test/invoices/INV-001",
        invoicePdf: "https://stripe.example.test/invoices/INV-001.pdf",
        lineItems: [
          {
            description: "Pro subscription",
            quantity: 1,
            amount: 12000,
            currency: "usd",
            priceId: "price_123",
            productId: "prod_123",
            recurringInterval: "month",
            recurringIntervalCount: 1,
          },
        ],
      },
    };
  },
  async listSubscriptions(input) {
    return {
      customerId: input.customerId ?? null,
      statusFilter: input.status,
      hasMore: false,
      subscriptions: [
        {
          id: "sub_123",
          status: "active",
          customerId: "cus_123",
          cancelAtPeriodEnd: false,
          currentPeriodStart: 1710000000,
          currentPeriodEnd: 1712592000,
          items: [
            {
              priceId: "price_123",
              nickname: "Pro Monthly",
              productId: "prod_123",
              currency: "usd",
              unitAmount: 12000,
              recurringInterval: "month",
              recurringIntervalCount: 1,
              quantity: 1,
            },
          ],
        },
      ],
    };
  },
  async listInvoices() {
    return [
      {
        id: "in_123",
        number: "INV-001",
        status: "paid",
        currency: "usd",
        subtotal: 12000,
        total: 12000,
        amountDue: 0,
        amountPaid: 12000,
        created: 1710003600,
        dueDate: null,
        customerId: "cus_123",
        hostedInvoiceUrl: "https://stripe.example.test/invoices/INV-001",
        invoicePdf: "https://stripe.example.test/invoices/INV-001.pdf",
        lineItems: [],
      },
    ];
  },
  async getAccount() {
    return {
      generatedAt: "2026-03-11T12:00:00Z",
      account: {
        id: "acct_123",
        email: "finance@example.com",
        country: "US",
        defaultCurrency: "usd",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        businessName: "Example Inc.",
        supportEmail: "support@example.com",
        supportUrl: "https://example.com/support",
      },
    };
  },
};

describe("stripe smoke test", () => {
  it("registers expected capabilities and invokes core billing tools", async () => {
    const server = createServer({
      config,
      client: fakeClient,
    });

    expect(server).toBeInstanceOf(StripeServer);
    expect(server.getToolNames()).toEqual(["get-invoice", "list-customers", "list-subscriptions"]);
    expect(server.getResourceNames()).toEqual(["account"]);
    expect(server.getPromptNames()).toEqual(["billing-audit"]);
    expect(serverCard.tools).toEqual(["list-customers", "get-invoice", "list-subscriptions"]);

    const customers = await server.invokeTool<{ customers: Array<{ id: string }> }>("list-customers", {
      limit: 5,
    });
    expect(customers.customers[0]?.id).toBe("cus_123");

    const invoice = await server.invokeTool<{ invoice: { number: string | null; lineItems: Array<{ priceId: string | null }> } }>(
      "get-invoice",
      {
        invoiceId: "in_123",
      },
    );
    expect(invoice.invoice.number).toBe("INV-001");
    expect(invoice.invoice.lineItems[0]?.priceId).toBe("price_123");

    const subscriptions = await server.invokeTool<{ subscriptions: Array<{ id: string; status: string }> }>(
      "list-subscriptions",
      {
        customerId: "cus_123",
        limit: 5,
        status: "all",
      },
    );
    expect(subscriptions.subscriptions[0]?.id).toBe("sub_123");
    expect(subscriptions.subscriptions[0]?.status).toBe("active");

    await server.close();
  });
});
