package com.igng.tokenmonitor.android.ui.more

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.igng.tokenmonitor.android.data.model.HubAccountDto
import com.igng.tokenmonitor.android.data.model.LimitsDto
import com.igng.tokenmonitor.android.data.model.SubscriptionDto
import com.igng.tokenmonitor.android.ui.HubUiState
import com.igng.tokenmonitor.android.ui.HubViewModel
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.EmptyState
import com.igng.tokenmonitor.android.ui.components.FluentButton
import com.igng.tokenmonitor.android.ui.components.FluentButtonVariant
import com.igng.tokenmonitor.android.ui.components.FluentDialog
import com.igng.tokenmonitor.android.ui.components.FluentIconButton
import com.igng.tokenmonitor.android.ui.components.FluentIcons
import com.igng.tokenmonitor.android.ui.components.FluentListRow
import com.igng.tokenmonitor.android.ui.components.FluentPageHeader
import com.igng.tokenmonitor.android.ui.components.FluentTextField
import com.igng.tokenmonitor.android.ui.components.FluentToggle
import com.igng.tokenmonitor.android.ui.components.LimitsSection
import com.igng.tokenmonitor.android.ui.components.formatRelativeTime
import com.igng.tokenmonitor.android.ui.components.limitAccountDisplayName
import com.igng.tokenmonitor.android.ui.haptics.HapticEvent
import com.igng.tokenmonitor.android.ui.haptics.rememberAppHaptics
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// ─── Hub account management ────────────────────────────────────────────────
//
// The client used to be a read-only mirror of quota: `LimitsUi` rendered the
// provider rows that ride on the stats snapshot, and everything that produces them —
// adding an account, pasting a cookie, starting an OAuth sign-in, forcing a refresh —
// existed only on the web.  That made the phone a viewer for a thing you configure on
// another device.
//
// Credential handling mirrors the Hub contract rather than inventing a client-side
// model: the field set is provider-specific (`docs/API.md` "The credential shape is
// provider-specific"), the Hub never echoes a credential back, and so nothing here
// holds one across a recomposition any longer than the dialog that is being typed into.

/**
 * Per-provider credential fields, in the order the web field editor shows them.
 *
 * This table is a deliberate copy of `src/shared-ui/views/accounts.js`'s simple-mode
 * field sets.  It is not generated from the Hub, because the Hub accepts any object and
 * the *shape* is a UI decision; the two lists have to be kept in step by hand, and
 * saying so here is cheaper than discovering it as a silent mismatch.
 */
internal object AccountCredentials {
  /** Providers whose credential is obtained by a Hub-side OAuth dance, not typed. */
  val oauthProviders = setOf("codex", "antigravity")

  /** Providers the web warns about before adding (token handling risks the account). */
  val riskNoticeProviders = setOf("claude", "codex", "antigravity", "gemini")

  private val fields: Map<String, List<Field>> = mapOf(
    "claude" to listOf(Field("accessToken", "访问令牌"), Field("refreshToken", "刷新令牌")),
    "codex" to listOf(Field("accessToken", "访问令牌"), Field("refreshToken", "刷新令牌")),
    "opencode" to listOf(Field("apiKey", "API Key"), Field("cookie", "Cookie")),
    "cursor" to listOf(Field("cookie", "Cookie")),
    "antigravity" to listOf(Field("csrfToken", "CSRF Token"), Field("endpoint", "端点")),
    "kimi" to listOf(Field("apiKey", "API Key"), Field("webAccessToken", "Web 访问令牌")),
    "grok" to listOf(Field("accessToken", "访问令牌")),
    "copilot" to listOf(Field("accessToken", "访问令牌"), Field("enterpriseHost", "企业主机")),
    "commandcode" to listOf(Field("apiKey", "API Key"), Field("cookie", "Cookie")),
    "mimo" to listOf(Field("serviceToken", "serviceToken"), Field("userId", "用户 ID"), Field("cookie", "Cookie")),
    "zai" to listOf(Field("apiKey", "API Key"), Field("region", "区域")),
    "zaiteam" to listOf(Field("apiKey", "API Key"), Field("org", "组织"), Field("project", "项目")),
    "kiro" to listOf(Field("accessToken", "访问令牌")),
    "qoder" to listOf(Field("cookie", "Cookie"), Field("site", "站点（global / cn）")),
    "qodercn" to listOf(Field("cookie", "Cookie"), Field("site", "站点（global / cn）")),
    "deepseek" to listOf(Field("apiKey", "API Key")),
    "openrouter" to listOf(Field("apiKey", "API Key")),
    "minimax" to listOf(Field("apiKey", "API Key")),
    "volcengine" to listOf(
      Field("accessKeyId", "AccessKeyId"),
      Field("secretAccessKey", "SecretAccessKey"),
      Field("apiKey", "API Key"),
      Field("region", "区域")
    ),
    "ollama" to listOf(Field("cookie", "Cookie")),
    "thirdparty" to listOf(
      Field("adapter", "适配器"),
      Field("baseUrl", "Base URL"),
      Field("apiKey", "API Key")
    )
  )

  /** Providers the picker offers; the union of the field table and the OAuth set. */
  val providers: List<String> = (fields.keys + oauthProviders).sorted()

  fun fieldsFor(provider: String): List<Field> = fields[provider].orEmpty()

  /** Providers with a free-form single field, used as the fallback for unknown ids. */
  fun fallbackFieldsFor(provider: String): List<Field> = listOf(Field("apiKey", "API Key"))

  data class Field(val key: String, val label: String)
}

@Composable
fun AccountsScreen(
  state: HubUiState,
  viewModel: HubViewModel,
  onBack: () -> Unit,
  onHome: (() -> Unit)? = null
) {
  val colors = LocalFluentColors.current
  val haptics = rememberAppHaptics()
  val owner = state.authorization?.authenticated == true
  var editing by remember { mutableStateOf<HubAccountDto?>(null) }
  var creating by remember { mutableStateOf(false) }

  Column(Modifier.fillMaxSize()) {
    FluentPageHeader(
      title = "配额账号",
      subtitle = if (owner) {
        "Hub 托管的账号凭据与额度刷新"
      } else {
        "连接 Hub 后管理托管的账号凭据与额度刷新"
      }
    )
    Row(
      Modifier
        .fillMaxWidth()
        .padding(horizontal = FluentSpacingDefaults.l),
      horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
    ) {
      FluentButton(
        label = "刷新列表",
        onClick = {
          haptics.perform(HapticEvent.Refresh)
          viewModel.refreshAccounts()
        },
        variant = FluentButtonVariant.Outline
      )
      if (owner) {
        FluentButton(
          label = "添加账号",
          onClick = {
            haptics.perform(HapticEvent.Tap)
            creating = true
          },
          leadingIcon = FluentIcons.Add
        )
      }
    }
    Spacer(Modifier.height(FluentSpacingDefaults.m))
    state.accountsError?.let { message ->
      AppCard(modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)) {
        Text(
          message,
          style = FluentTypeRamp.body2,
          color = colors.errorForeground
        )
      }
      Spacer(Modifier.height(FluentSpacingDefaults.m))
    }
    val accounts = state.accounts
    when {
      state.accountsLoading && accounts.isEmpty() -> AppCard(
        modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)
      ) {
        Text("正在读取账号…", style = FluentTypeRamp.body2, color = colors.neutralForeground2)
      }
      accounts.isEmpty() -> EmptyState(
        title = "还没有配额账号",
        text = if (owner) {
          "添加一个账号后，Hub 会按它自己的节奏抓取额度，这个页面和「服务状态」都会显示结果。"
        } else {
          "请先连接 Hub 并使用共享密钥。"
        }
      )
      else -> LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
          start = FluentSpacingDefaults.l,
          end = FluentSpacingDefaults.l,
          bottom = FluentSpacingDefaults.xxxl
        ),
        verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
      ) {
        accounts.forEachIndexed { index, account ->
          item(key = account.id) {
              AccountCard(
              account = account,
                isOwner = owner,
              onRefresh = {
                haptics.perform(HapticEvent.Refresh)
                viewModel.refreshAccountQuota(account.id)
              },
              onToggleEnabled = { enabled ->
                haptics.perform(HapticEvent.Selection)
                viewModel.saveAccount(
                  accountId = account.id,
                  provider = account.provider,
                  name = account.name,
                  label = account.label,
                  enabled = enabled,
                  credential = null
                )
              },
              onEdit = {
                haptics.perform(HapticEvent.Tap)
                editing = account
              },
              onDelete = {
                haptics.perform(HapticEvent.Error)
                viewModel.deleteAccount(account.id)
              },
              dividerAbove = index > 0
            )
          }
        }
      }
    }
  }

  if (creating || editing != null) {
    AccountEditorDialog(
      existing = editing,
      onDismiss = { creating = false; editing = null },
      onSave = { provider, name, label, credential ->
        viewModel.saveAccount(
          accountId = editing?.id,
          provider = provider,
          name = name,
          label = label,
          enabled = editing?.enabled ?: true,
          credential = credential
        )
        creating = false
        editing = null
      },
      onStartOAuth = { provider -> viewModel.startOAuth(provider) },
      // The exchange must target the account being edited, or "finish login" would
      // post a new account and the Hub would reject it as a duplicate.
      onExchangeOAuth = { sessionId, pasted, name, label ->
        viewModel.exchangeOAuth(sessionId, pasted, name, label, editing?.id)
      },
      onClearOAuth = { viewModel.clearOAuthSession() },
      onClearCredential = editing?.let { account ->
        { viewModel.clearAccountCredential(account.id) }
      },
      oauthSession = state.oauthSession
    )
  }
}

@Composable
private fun AccountCard(
  account: HubAccountDto,
  isOwner: Boolean,
  onRefresh: () -> Unit,
  onToggleEnabled: (Boolean) -> Unit,
  onEdit: () -> Unit,
  onDelete: () -> Unit,
  dividerAbove: Boolean
) {
  val colors = LocalFluentColors.current
  var confirmDelete by remember(account.id) { mutableStateOf(false) }
  val display = limitAccountDisplayName(
    com.igng.tokenmonitor.android.data.model.LimitProviderDto(
      provider = account.provider,
      accountLabel = account.label,
      accountName = account.accountName,
      accountEmail = account.accountEmail
    )
  )
  val status = account.status?.lowercase()
  // Status is spelled out as well as coloured: ok / unauthorized / rate-limited /
  // stale / disabled each need a different fix, and a dot colour cannot say which.
  val statusLabel = when {
    !account.enabled -> "已禁用"
    status == "ok" -> "正常"
    status == "refreshing" || status == "pending" -> "刷新中"
    status == "unauthorized" -> "需要重新授权"
    status == "ratelimited" -> "触发限流"
    status == "notconfigured" -> "未配置凭据"
    !status.isNullOrBlank() -> status
    else -> "未知"
  }
  AppCard {
    FluentListRow(
      primary = display,
      secondary = listOfNotNull(
        account.provider,
        account.plan?.takeIf { it.isNotBlank() },
        account.name?.takeIf { it.isNotBlank() }
      ).joinToString(" · "),
      tertiary = account.lastSuccessAt?.let { "最近成功 ${formatRelativeTime(it)}" }
        ?: account.lastError?.let { "上次失败：$it" },
      trailing = {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(
            statusLabel,
            style = FluentTypeRamp.caption1,
            fontWeight = FontWeight.SemiBold,
            color = when {
              status == "ok" && account.enabled -> colors.successForeground
              !account.enabled -> colors.neutralForeground3
              else -> colors.warningForeground
            }
          )
          Spacer(Modifier.width(FluentSpacingDefaults.xs))
          FluentIconButton(
            icon = FluentIcons.ArrowSync,
            contentDescription = "立即刷新 $display 的额度",
            onClick = onRefresh,
            tint = colors.brandForeground1,
            targetSize = 40.dp,
            iconSize = 18.dp
          )
        }
      },
      contentPadding = 0.dp,
      dividerAbove = dividerAbove
    )
    if (isOwner) {
      Spacer(Modifier.height(FluentSpacingDefaults.s))
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text("启用", style = FluentTypeRamp.body2, color = colors.neutralForeground1)
          Text(
            "关闭后 Hub 不再抓取这个账号的额度。",
            style = FluentTypeRamp.caption2,
            color = colors.neutralForeground3
          )
        }
        FluentToggle(
          checked = account.enabled,
          onCheckedChange = onToggleEnabled,
          label = "启用 ${display}"
        )
      }
      Spacer(Modifier.height(FluentSpacingDefaults.s))
      Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
        FluentButton(
          label = "编辑凭据",
          onClick = onEdit,
          variant = FluentButtonVariant.Subtle
        )
        FluentButton(
          label = if (confirmDelete) "确认删除" else "删除",
          onClick = {
            if (confirmDelete) onDelete() else confirmDelete = true
          },
          variant = if (confirmDelete) FluentButtonVariant.Filled else FluentButtonVariant.Outline
        )
      }
    }
    account.limits?.let { provider ->
      Spacer(Modifier.height(FluentSpacingDefaults.m))
      // The Hub stores one provider row per account, so wrap it in the
      // single-provider `LimitsDto` shape `LimitsSection` renders.
      LimitsSection(
        limits = LimitsDto(providers = listOf(provider)),
        title = "当前额度",
        includeAllProviders = true
      )
    }
  }
}

/**
 * Create/edit dialog.  A credential is typed into local state and handed to the
 * callback as a [JsonObject]; it is never stored in [HubUiState], because the Hub
 * does not return one and a client that kept its own copy would be holding plaintext
 * it cannot refresh or reconcile.
 */
@Composable
internal fun AccountEditorDialog(
  existing: HubAccountDto?,
  onDismiss: () -> Unit,
  onSave: (provider: String, name: String?, label: String?, credential: JsonObject?) -> Unit,
  onStartOAuth: (String) -> Unit,
  onExchangeOAuth: (sessionId: String, pasted: String, name: String?, label: String?) -> Unit,
  onClearOAuth: () -> Unit,
  onClearCredential: (() -> Unit)?,
  oauthSession: com.igng.tokenmonitor.android.data.model.OAuthStartDto?
) {
  val colors = LocalFluentColors.current
  val uriHandler = LocalUriHandler.current
  var provider by remember(existing) { mutableStateOf(existing?.provider ?: "claude") }
  var name by remember(existing) { mutableStateOf(existing?.name.orEmpty()) }
  var label by remember(existing) { mutableStateOf(existing?.label.orEmpty()) }
  val fields = remember(provider) {
    AccountCredentials.fieldsFor(provider).ifEmpty { AccountCredentials.fallbackFieldsFor(provider) }
  }
  val values = remember(provider) { mutableStateOf(fields.associate { it.key to "" }) }
  // The paste buffer belongs to *one* provider's sign-in.  Switching provider used to
  // keep the previous authorization code, which the next exchange would have sent.
  var pasted by remember(provider) { mutableStateOf("") }
  LaunchedEffect(provider) { onClearOAuth() }
  val isOauth = AccountCredentials.oauthProviders.contains(provider)
  val needsCredential = !isOauth && existing == null
  val credentialFilled = values.value.values.any { it.isNotBlank() }
  val valid = provider.isNotBlank() && (!needsCredential || credentialFilled)

  FluentDialog(
    onDismissRequest = onDismiss,
    title = if (existing == null) "添加配额账号" else "编辑 ${existing.provider} 账号",
    subtitle = if (isOauth) {
      "该提供商走 Hub 侧 OAuth：先点「开始登录」，在浏览器完成，再把回调地址粘回来。"
    } else {
      "凭据只会发给 Hub 加密保存，响应里不会回传，所以编辑时需要重新粘贴。"
    },
    // The account is created by the *exchange* for an OAuth provider: posting a null
    // credential would leave a configured-but-empty account behind.
    confirmText = if (isOauth) null else if (existing == null) "添加" else "保存",
    onConfirm = if (!isOauth && valid) {
      {
        onSave(
          provider,
          name.ifBlank { null },
          label.ifBlank { null },
          buildJsonObject {
            values.value.forEach { (key, value) ->
              if (value.isNotBlank()) put(key, JsonPrimitive(value.trim()))
            }
          }
        )
      }
    } else {
      null
    },
    dismissText = "取消"
  ) {
    Column(
      Modifier
        .heightIn(max = 480.dp)
        .verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
    ) {
      if (existing == null) {
        AccountProviderPicker(selected = provider, onSelect = { provider = it })
      } else {
        Text(
          "提供商：${existing.provider}",
          style = FluentTypeRamp.body2,
          color = colors.neutralForeground2
        )
      }
      FluentTextField(value = name, onValueChange = { name = it }, label = "名称（可选）")
      FluentTextField(value = label, onValueChange = { label = it }, label = "展示标签（可选）")
      if (AccountCredentials.riskNoticeProviders.contains(provider)) {
        Text(
          "提示：使用非官方登录凭据可能触发提供商风控，账户存在被限制的风险。",
          style = FluentTypeRamp.caption2,
          color = colors.warningForeground
        )
      }
      if (isOauth) {
        Text(
          if (existing == null) {
            "账号由完成授权时创建：先登录，再把回调地址粘回来并点「完成登录」。"
          } else {
            "该账号已保存凭据。重新登录并粘贴结果即可原地替换，账号本身保留。"
          },
          style = FluentTypeRamp.caption2,
          color = colors.neutralForeground3
        )
        if (existing != null) {
          // The Hub never echoes a credential, so the best this can show is whether
          // one is stored — which is the question "am I still authorized?".
          val configured = existing.credentialConfigured
          Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
              Text(
                when (configured) {
                  false -> "未填写凭据 — 请重新登录"
                  null -> "凭据状态未知"
                  else -> "已填写凭据"
                },
                style = FluentTypeRamp.caption1,
                color = if (configured == false) colors.warningForeground else colors.neutralForeground1
              )
              existing.credentialMetadata?.let { metadata ->
                val identity = listOfNotNull(
                  existing.accountEmail?.takeIf { it.isNotBlank() },
                  metadata["accountId"]?.let { it.toString().trim('"').takeIf { text -> text.isNotBlank() } }
                ).joinToString(" · ")
                if (identity.isNotBlank()) {
                  Text(identity, style = FluentTypeRamp.caption2, color = colors.neutralForeground3)
                }
              }
            }
            if (onClearCredential != null) {
              FluentButton(
                label = "清除凭据",
                onClick = onClearCredential,
                variant = FluentButtonVariant.Outline
              )
            }
          }
        }
        FluentButton(
          label = if (oauthSession != null) "重新开始登录" else "开始登录",
          onClick = {
            // A fresh sign-in invalidates the previous session; keeping its paste buffer
            // would let the next 完成登录 exchange a code that was never issued by it.
            pasted = ""
            onStartOAuth(provider)
          },
          variant = FluentButtonVariant.Subtle
        )
        oauthSession?.let { session ->
          if (!session.authUrl.isNullOrBlank()) {
            FluentButton(
              label = "在浏览器打开授权页",
              onClick = { uriHandler.openUri(session.authUrl) },
              variant = FluentButtonVariant.Quiet
            )
          }
          FluentTextField(
            value = pasted,
            onValueChange = { pasted = it },
            label = "粘贴回调地址或授权码",
            supportingText = "完整回调 URL、带查询串的地址、或裸授权码都可以，客户端不解析。"
          )
          FluentButton(
            label = "完成登录",
            onClick = {
              val sessionId = session.sessionId
              if (!sessionId.isNullOrBlank() && pasted.isNotBlank()) {
                onExchangeOAuth(sessionId, pasted, name.ifBlank { null }, label.ifBlank { null })
              }
            },
            enabled = !session.sessionId.isNullOrBlank() && pasted.isNotBlank()
          )
        }
      } else {
        fields.forEach { field ->
          FluentTextField(
            value = values.value[field.key].orEmpty(),
            onValueChange = { next -> values.value = values.value + (field.key to next) },
            label = field.label,
            isPassword = field.key.contains("token", ignoreCase = true) ||
              field.key.equals("apiKey", ignoreCase = true) ||
              field.key.equals("cookie", ignoreCase = true),
            keyboardType = KeyboardType.Text
          )
        }
        if (needsCredential && !credentialFilled) {
          Text(
            "至少填写一项凭据。",
            style = FluentTypeRamp.caption2,
            color = colors.errorForeground
          )
        }
      }
    }
  }
}

/**
 * Scrollable provider choice.  Fluent's Dropdown is an overlay anchored to the
 * trigger; on a phone that overlay is the keyboard-sized problem the web solves with a
 * native `select`.  A list of radio rows inside the dialog is both reachable with a
 * thumb and announces selection state, which a collapsed control does not.
 */
@Composable
private fun AccountProviderPicker(selected: String, onSelect: (String) -> Unit) {
  val colors = LocalFluentColors.current
  Text(
    "提供商",
    style = FluentTypeRamp.caption1,
    fontWeight = FontWeight.SemiBold,
    color = colors.neutralForeground2
  )
  Spacer(Modifier.height(FluentSpacingDefaults.xs))
  Column(
    Modifier
      .fillMaxWidth()
      .heightIn(max = 220.dp)
      .verticalScroll(rememberScrollState())
  ) {
    AccountCredentials.providers.forEach { provider ->
      com.igng.tokenmonitor.android.ui.components.FluentChoiceRow(
        selected = provider == selected,
        onSelect = { onSelect(provider) },
        label = provider
      )
    }
  }
}

// ─── Subscription ledger ───────────────────────────────────────────────────

@Composable
fun SubscriptionsScreen(
  state: HubUiState,
  viewModel: HubViewModel,
  onBack: () -> Unit,
  onHome: (() -> Unit)? = null
) {
  val colors = LocalFluentColors.current
  val haptics = rememberAppHaptics()
  var editing by remember { mutableStateOf<SubscriptionDto?>(null) }
  var creating by remember { mutableStateOf(false) }
  val monthly = remember(state.subscriptions) { monthlyEquivalent(state.subscriptions) }

  Column(Modifier.fillMaxSize()) {
    FluentPageHeader(
      title = "订阅",
      subtitle = "手工记账的计划价，Hub 全局保存一份；金额是你输入的值，不从提供商读取"
    )
    AppCard(modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)) {
      Text(
        "月度折算",
        style = FluentTypeRamp.title3,
        color = colors.neutralForeground1
      )
      Spacer(Modifier.height(FluentSpacingDefaults.xs))
      if (monthly.isEmpty()) {
        Text("暂无记录。", style = FluentTypeRamp.caption1, color = colors.neutralForeground2)
      } else {
        monthly.forEach { (currency, total) ->
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
          ) {
            Text(currency, style = FluentTypeRamp.body2, color = colors.neutralForeground2)
            Text(
              "%.2f".format(total),
              style = FluentTypeRamp.body2,
              fontWeight = FontWeight.SemiBold,
              color = colors.neutralForeground1
            )
          }
        }
      }
      Spacer(Modifier.height(FluentSpacingDefaults.s))
      Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
        FluentButton(
          label = "添加记录",
          onClick = {
            haptics.perform(HapticEvent.Tap)
            creating = true
          },
          leadingIcon = FluentIcons.Add
        )
        FluentButton(
          label = "刷新",
          onClick = {
            haptics.perform(HapticEvent.Refresh)
            viewModel.refreshSubscriptions()
          },
          variant = FluentButtonVariant.Outline
        )
      }
    }
    state.subscriptionsError?.let { message ->
      AppCard(modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)) {
        Text(message, style = FluentTypeRamp.body2, color = colors.errorForeground)
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        Text(
          "如果提示版本冲突，说明另一个客户端刚改过台账；先刷新再看，不要重复保存。",
          style = FluentTypeRamp.caption2,
          color = colors.neutralForeground3
        )
      }
    }
    val rows = state.subscriptions
    if (rows.isEmpty()) {
      EmptyState(title = "还没有订阅记录", text = "计划价与自动续费周期由你自己录入。")
    } else {
      LazyColumn(
        modifier = Modifier
          .fillMaxSize()
          .padding(horizontal = FluentSpacingDefaults.l),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
          bottom = FluentSpacingDefaults.xxxl
        ),
        verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
      ) {
        rows.forEachIndexed { index, subscription ->
          item(key = subscription.id) {
            AppCard {
              FluentListRow(
                primary = subscription.plan?.ifBlank { null } ?: subscription.provider ?: "未命名",
                secondary = listOfNotNull(
                  subscription.provider,
                  subscription.interval?.let { interval ->
                    val count = subscription.intervalCount ?: 1
                    if (count > 1) "$interval × $count" else interval
                  },
                  subscription.currency
                ).joinToString(" · "),
                trailingPrimary = subscription.amount?.let { "%.2f".format(it) } ?: "—",
                tertiary = subscription.nextRenewalOverride
                  ?.let { "下次续费 $it" }
                  ?: subscription.startDate?.let { "起始 $it" },
                onClick = { editing = subscription },
                contentPadding = 0.dp,
                dividerAbove = index > 0
              )
            }
          }
        }
      }
    }
  }

  if (creating || editing != null) {
    SubscriptionEditorDialog(
      existing = editing,
      onDismiss = { creating = false; editing = null },
      onSave = { next ->
        // Snapshot of the delegated `editing`, which cannot smart-cast inside this
        // lambda.
        val target = editing
        val current = state.subscriptions
        val updated = if (target == null) {
          current + next
        } else {
          current.map { if (it.id == target.id) next.copy(id = target.id) else it }
        }
        viewModel.saveSubscriptions(updated)
        creating = false
        editing = null
      },
      onDelete = editing?.let { target ->
        {
          viewModel.saveSubscriptions(state.subscriptions.filterNot { it.id == target.id })
          creating = false
          editing = null
        }
      }
    )
  }
}

/**
 * Monthly-equivalent spend per currency.
 *
 * Same folding rule as the web ledger: an annual plan divides by 12, an
 * `intervalCount` stretches the cadence, and a top-up is *not* amortised — it was
 * spent this month or it was not.  Averaging a top-up would understate the month it
 * happened in, which is the number this screen exists to answer.
 */
internal fun monthlyEquivalent(subscriptions: List<SubscriptionDto>): Map<String, Double> {
  val totals = linkedMapOf<String, Double>()
  for (record in subscriptions) {
    val amount = record.amount ?: continue
    val currency = record.currency?.ifBlank { null } ?: "USD"
    if (record.recordType?.lowercase() == "topup") {
      totals[currency] = (totals[currency] ?: 0.0) + amount
      continue
    }
    val perInterval = when (record.interval?.lowercase()) {
      "week" -> amount * 52 / 12
      "quarter" -> amount / 3
      "year", "annual" -> amount / 12
      else -> amount
    }
    val divisor = (record.intervalCount ?: 1).coerceAtLeast(1)
    totals[currency] = (totals[currency] ?: 0.0) + perInterval / divisor
  }
  return totals
}

@Composable
private fun SubscriptionEditorDialog(
  existing: SubscriptionDto?,
  onDismiss: () -> Unit,
  onSave: (SubscriptionDto) -> Unit,
  onDelete: (() -> Unit)?
) {
  var provider by remember(existing) { mutableStateOf(existing?.provider.orEmpty()) }
  var plan by remember(existing) { mutableStateOf(existing?.plan.orEmpty()) }
  var amount by remember(existing) { mutableStateOf(existing?.amount?.toString().orEmpty()) }
  var currency by remember(existing) { mutableStateOf(existing?.currency ?: "USD") }
  var interval by remember(existing) { mutableStateOf(existing?.interval ?: "month") }
  var startDate by remember(existing) { mutableStateOf(existing?.startDate.orEmpty()) }
  var note by remember(existing) { mutableStateOf(existing?.note.orEmpty()) }
  var autoRenew by remember(existing) { mutableStateOf(existing?.autoRenew ?: true) }
  val parsed = amount.toDoubleOrNull()
  val valid = parsed != null && parsed >= 0 && plan.isNotBlank()

  FluentDialog(
    onDismissRequest = onDismiss,
    title = if (existing == null) "添加订阅记录" else "编辑订阅记录",
    subtitle = "日期格式 YYYY-MM-DD；金额按你填写的币种记账。",
    confirmText = "保存",
    onConfirm = if (valid) {
      {
        onSave(
          SubscriptionDto(
            id = existing?.id ?: "",
            provider = provider.ifBlank { null },
            plan = plan.trim(),
            amount = parsed,
            currency = currency,
            interval = interval,
            intervalCount = existing?.intervalCount,
            startDate = startDate.ifBlank { null },
            endDate = existing?.endDate,
            nextRenewalOverride = existing?.nextRenewalOverride,
            autoRenew = autoRenew,
            recordType = existing?.recordType ?: "recurring",
            accountEmail = existing?.accountEmail,
            profileName = existing?.profileName,
            note = note.ifBlank { null }
          )
        )
      }
    } else {
      null
    },
    dismissText = "取消"
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)) {
      FluentTextField(value = provider, onValueChange = { provider = it }, label = "提供商（可选）")
      FluentTextField(value = plan, onValueChange = { plan = it }, label = "计划名称")
      FluentTextField(
        value = amount,
        onValueChange = { amount = it },
        label = "金额",
        keyboardType = KeyboardType.Decimal,
        errorText = if (parsed == null && amount.isNotEmpty()) "请输入非负数字。" else null
      )
      Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
        listOf("USD", "CNY", "TWD", "HKD").forEach { option ->
          FluentButton(
            label = option,
            onClick = { currency = option },
            variant = if (currency == option) FluentButtonVariant.Filled else FluentButtonVariant.Outline
          )
        }
      }
      Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
        listOf("month", "year", "week", "quarter").forEach { option ->
          FluentButton(
            label = option,
            onClick = { interval = option },
            variant = if (interval == option) FluentButtonVariant.Filled else FluentButtonVariant.Outline
          )
        }
      }
      FluentTextField(
        value = startDate,
        onValueChange = { startDate = it },
        label = "起始日期",
        placeholder = "2026-01-01"
      )
      FluentTextField(value = note, onValueChange = { note = it }, label = "备注（可选）")
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
          "自动续费",
          style = FluentTypeRamp.body2,
          color = LocalFluentColors.current.neutralForeground1,
          modifier = Modifier.weight(1f)
        )
        FluentToggle(checked = autoRenew, onCheckedChange = { autoRenew = it }, label = "自动续费")
      }
      if (onDelete != null) {
        FluentButton(label = "删除这条记录", onClick = onDelete, variant = FluentButtonVariant.Outline)
      }
    }
  }
}
