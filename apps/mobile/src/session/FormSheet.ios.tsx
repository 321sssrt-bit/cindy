import { ActivityIndicator, Modal, ScrollView, StyleSheet } from 'react-native';
import { ScreenStack, ScreenStackItem } from 'react-native-screens';
import { spacing, useTheme } from '@/theme';
import type { FormSheetProps } from './FormSheet';

/** UIKit navigation in a page sheet; onClosed waits for native dismissal. */
export function FormSheet({
  visible, title, onClose, onClosed, onShow, preventDismiss = false,
  leadingAction, trailingAction, children, testID,
}: FormSheetProps) {
  const { mode, colors } = useTheme();
  return (
    <Modal
      visible={visible}
      presentationStyle="pageSheet"
      animationType="slide"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      allowSwipeDismissal={!preventDismiss}
      onRequestClose={onClose}
      onDismiss={onClosed}
      onShow={onShow}
    >
      <ScreenStack style={styles.fill} nativeContainerStyle={{ backgroundColor: colors.surface }}>
        <ScreenStackItem
          screenId={testID ?? 'form-sheet'}
          activityState={2}
          style={styles.fill}
          contentStyle={{ backgroundColor: colors.surface }}
          headerConfig={{
            title,
            hidden: false,
            hideBackButton: true,
            hideShadow: true,
            translucent: false,
            backgroundColor: colors.surface,
            color: colors.textPrimary,
            titleColor: colors.textPrimary,
            experimental_userInterfaceStyle: mode,
            headerLeftBarButtonItems: [{
              type: 'button',
              icon: { type: 'sfSymbol', name: 'xmark' },
              variant: 'plain',
              accessibilityLabel: leadingAction.accessibilityLabel ?? leadingAction.label,
              identifier: leadingAction.testID,
              disabled: !!leadingAction.disabled || !!leadingAction.busy,
              onPress: leadingAction.onPress,
            }],
            headerRightBarButtonItems: [{
              type: 'button',
              title: trailingAction.label,
              // iOS 26 aliases `done` to `prominent`, which fills the glass.
              variant: 'plain',
              accessibilityLabel: trailingAction.accessibilityLabel ?? trailingAction.label,
              identifier: trailingAction.testID,
              disabled: !!trailingAction.disabled || !!trailingAction.busy,
              onPress: trailingAction.onPress,
            }],
          }}
        >
          <ScrollView
            testID={testID}
            style={styles.fill}
            contentContainerStyle={styles.content}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {children}
          </ScrollView>
          {trailingAction.busy ? <ActivityIndicator style={styles.progress} color={colors.textSecondary}
            accessibilityLabel={trailingAction.accessibilityLabel ?? trailingAction.label} /> : null}
        </ScreenStackItem>
      </ScreenStack>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  progress: { paddingVertical: spacing.sm },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg },
});
