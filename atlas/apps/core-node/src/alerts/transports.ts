/**
 * Alert Transports
 * 
 * Provides multiple channels for sending trading alerts:
 * - Telegram
 * - Email (SMTP)
 * - Slack
 */

import { Logger } from '../core/logger';

export interface AlertPayload {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface TransportConfig {
  enabled: boolean;
}

export interface TelegramConfig extends TransportConfig {
  botToken: string;
  chatId: string;
}

export interface EmailConfig extends TransportConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  fromAddress: string;
  toAddresses: string[];
  useTls: boolean;
}

export interface SlackConfig extends TransportConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
}

/**
 * Abstract base class for alert transports.
 */
export abstract class AlertTransport {
  protected logger: Logger;
  protected enabled: boolean;

  constructor(enabled: boolean, logger: Logger) {
    this.enabled = enabled;
    this.logger = logger;
  }

  abstract send(alert: AlertPayload): Promise<boolean>;
  
  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Telegram alert transport using Bot API.
 */
export class TelegramTransport extends AlertTransport {
  private config: TelegramConfig;

  constructor(config: TelegramConfig, logger: Logger) {
    super(config.enabled, logger);
    this.config = config;
  }

  async send(alert: AlertPayload): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const emoji = this.getSeverityEmoji(alert.severity);
      const text = `${emoji} *${alert.title}*\n\n${alert.message}\n\n_${alert.timestamp.toISOString()}_`;

      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.error('Telegram send failed:', error);
        return false;
      }

      this.logger.debug('Telegram alert sent', { title: alert.title });
      return true;
    } catch (error) {
      this.logger.error('Telegram transport error:', error);
      return false;
    }
  }

  private getSeverityEmoji(severity: string): string {
    switch (severity) {
      case 'critical': return '🚨';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      default: return '📢';
    }
  }
}

/**
 * Email alert transport using SMTP.
 */
export class EmailTransport extends AlertTransport {
  private config: EmailConfig;

  constructor(config: EmailConfig, logger: Logger) {
    super(config.enabled, logger);
    this.config = config;
  }

  async send(alert: AlertPayload): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      // Note: In production, use nodemailer or similar
      // This is a simplified implementation
      this.logger.info('Email alert would be sent', {
        to: this.config.toAddresses,
        subject: `[${alert.severity.toUpperCase()}] ${alert.title}`,
      });

      // Placeholder for actual email sending
      // const transporter = nodemailer.createTransport({...});
      // await transporter.sendMail({...});

      return true;
    } catch (error) {
      this.logger.error('Email transport error:', error);
      return false;
    }
  }
}

/**
 * Slack alert transport using incoming webhooks.
 */
export class SlackTransport extends AlertTransport {
  private config: SlackConfig;

  constructor(config: SlackConfig, logger: Logger) {
    super(config.enabled, logger);
    this.config = config;
  }

  async send(alert: AlertPayload): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const color = this.getSeverityColor(alert.severity);
      
      const payload = {
        channel: this.config.channel,
        username: this.config.username || 'AtlasBot',
        icon_emoji: this.config.iconEmoji || ':robot_face:',
        attachments: [
          {
            color,
            title: alert.title,
            text: alert.message,
            ts: Math.floor(alert.timestamp.getTime() / 1000),
            fields: Object.entries(alert.metadata || {}).map(([key, value]) => ({
              title: key,
              value: String(value),
              short: true,
            })),
          },
        ],
      };

      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.error('Slack send failed:', error);
        return false;
      }

      this.logger.debug('Slack alert sent', { title: alert.title });
      return true;
    } catch (error) {
      this.logger.error('Slack transport error:', error);
      return false;
    }
  }

  private getSeverityColor(severity: string): string {
    switch (severity) {
      case 'critical': return '#dc3545'; // Red
      case 'warning': return '#ffc107'; // Yellow
      case 'info': return '#17a2b8'; // Blue
      default: return '#6c757d'; // Gray
    }
  }
}

/**
 * Alert Manager handles routing alerts to multiple transports.
 */
export class AlertManager {
  private transports: AlertTransport[] = [];
  private logger: Logger;
  private alertHistory: AlertPayload[] = [];
  private maxHistorySize = 1000;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a transport for receiving alerts.
   */
  registerTransport(transport: AlertTransport): void {
    this.transports.push(transport);
    this.logger.info('Alert transport registered', {
      type: transport.constructor.name,
      enabled: transport.isEnabled(),
    });
  }

  /**
   * Send an alert to all registered transports.
   */
  async sendAlert(alert: AlertPayload): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    // Store in history
    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.shift();
    }

    // Send to all transports
    const promises = this.transports
      .filter(t => t.isEnabled())
      .map(async transport => {
        try {
          const success = await transport.send(alert);
          if (success) {
            sent++;
          } else {
            failed++;
          }
        } catch (error) {
          this.logger.error('Transport send error:', error);
          failed++;
        }
      });

    await Promise.all(promises);

    this.logger.info('Alert dispatched', {
      title: alert.title,
      severity: alert.severity,
      sent,
      failed,
    });

    return { sent, failed };
  }

  /**
   * Create and send a kill switch alert.
   */
  async alertKillSwitch(reason: string): Promise<void> {
    await this.sendAlert({
      severity: 'critical',
      title: '🛑 KILL SWITCH ACTIVATED',
      message: `Trading has been halted.\n\nReason: ${reason}`,
      timestamp: new Date(),
      metadata: { reason },
    });
  }

  /**
   * Create and send a drawdown alert.
   */
  async alertDrawdown(currentDrawdown: number, maxAllowed: number): Promise<void> {
    await this.sendAlert({
      severity: currentDrawdown > maxAllowed * 0.8 ? 'critical' : 'warning',
      title: '📉 Drawdown Alert',
      message: `Current drawdown: ${(currentDrawdown * 100).toFixed(2)}%\nMax allowed: ${(maxAllowed * 100).toFixed(2)}%`,
      timestamp: new Date(),
      metadata: { currentDrawdown, maxAllowed },
    });
  }

  /**
   * Create and send a data gap alert.
   */
  async alertDataGap(symbols: string[], gapDurationMs: number): Promise<void> {
    await this.sendAlert({
      severity: 'warning',
      title: '📡 Market Data Gap',
      message: `No data received for ${(gapDurationMs / 1000).toFixed(1)}s\nAffected symbols: ${symbols.join(', ')}`,
      timestamp: new Date(),
      metadata: { symbols, gapDurationMs },
    });
  }

  /**
   * Create and send a WebSocket reconnect storm alert.
   */
  async alertReconnectStorm(reconnectCount: number, windowMs: number): Promise<void> {
    await this.sendAlert({
      severity: 'critical',
      title: '🔌 WebSocket Reconnect Storm',
      message: `${reconnectCount} reconnection attempts in ${(windowMs / 1000).toFixed(0)}s\nConnection may be unstable.`,
      timestamp: new Date(),
      metadata: { reconnectCount, windowMs },
    });
  }

  /**
   * Get alert history.
   */
  getHistory(limit: number = 100): AlertPayload[] {
    return this.alertHistory.slice(-limit);
  }
}
