const { WebUtils, Logger } = require('@dojot/microservice-sdk')
const jwt = require('jsonwebtoken')
const process = require('process')

const logger = new Logger('kong-keycloak-plugin');

/**
 * Format certificate in x5c format
 *
 * @param {string} base64PublicKey Public key in base64
 *
 * @returns rsa cerficate
 */
 function formatCertificate(base64PublicKey) {
  let certificate = '-----BEGIN CERTIFICATE-----\n';
  const chucks = base64PublicKey.match(/.{1,64}/g);
  certificate += chucks.join('\n');
  certificate += '\n-----END CERTIFICATE-----';

  return certificate;
}

class KeycloakPlugin {
  constructor(config) {
    this.config = config
    this.config.keycloak = process.env.KONG_KEYCLOAK_URL
    this.tenants = new Map();
    this.dojotHttpClient = new WebUtils.DojotHttpClient({
      defaultClientOptions: {
        baseUrl: this.config.keycloak,
        method: "GET",
      },
      logger,
      defaultRetryDelay: 5000,
      defaultMaxNumberAttempts: 3,
    })
    this.cacheExpirationTime = 180;
  }

  async tenantHandler(tenantId) {
    if(this.tenants.has(tenantId)){
      const value = this.tenants.get(tenantId)
      const timePast = (new Date().getTime() - value.createdAt.getTime) / 1000

      if ( timePast > this.cacheExpirationTime ){
        return await this.updateTenants(tenantId)
      }

      return value.data;
    } else {
      return await this.updateTenants(tenantId)
    }
  }

  async updateTenants(tenantId) {
    try {
      const tenantInfo = await this.dojotHttpClient.request({
        url: `/auth/realms/${tenantId}`
      });
      this.tenants.set(tenantId, { data: tenantInfo.data, createdAt: new Date()});
      return tenantInfo.data;
    } catch (error) {
      return undefined
    }
  }

  async access(kong) {
    let prefix;
    let tokenRaw;
    let requestTenant;
    const keycloaAccessToken = await kong.request.getHeader('Authorization')

    try {
      [prefix, tokenRaw] = keycloaAccessToken.split(' ');
    } catch (error) {
      await kong.response.exit(401, { error: 'Unauthorized access', message: 'Invalid Authorization header' })
      return;
    }

    if (prefix === 'Bearer') {
      let tenant;
      try {
        logger.debug('Decoding access_token.');
        const tokenDecoded = jwt.decode(tokenRaw);
        logger.debug('Getting tenant.');
        requestTenant = tokenDecoded.iss.split('/').pop();
        tenant = await this.tenantHandler(requestTenant)
      } catch (decodedError) {
        await kong.response.exit(401, { error: 'Unauthorized access', message: 'Invalid access token' })
        return
      }

      if (tenant) {
        logger.debug('Verify access_token.');
        jwt.verify(
          tokenRaw,
          formatCertificate(tenant.signatureKey.certificate),
          { algorithms: [tenant.signatureKey.algorithm] },
          (verifyTokenError) => {
            if (verifyTokenError) {
              logger.debug(verifyTokenError.message);
              kong.response.exit(401, { error: 'Unauthorized access', message: verifyTokenError.message });
              return
            }
            logger.debug('Successfully verified.');
            const tokenGen = WebUtils.createTokenGen();
            tokenGen.generate({ tenant: tenant.id, payload: {}}).then((dojotAccessToken) => {
              kong.service.request.setHeader('Authorization', `Bearer ${dojotAccessToken}`).then(() => {
                logger.debug('Successful token change')
              }).catch((error) => {
                logger.error(error.message)
                kong.response.exit(500, { error: 'Change token failed', message: error.message });
              })
            }).catch((error) => {
              logger.error(error.message)
              kong.response.exit(500, { error: 'Change token failed', message: error.message });
            })
          },
        );
      } else {
        await kong.response.exit(401, { error: 'Unauthorized access', message: 'Tenant not found', metadata: this.tenants.size() })
        return
      }
    } else {
      await kong.response.exit(401, { error: 'Unauthorized access', message: 'Invalid Authorization header' })
      return;
    }
  }
}

module.exports = {
  Plugin: KeycloakPlugin,
  Version: "1.0.0"
};